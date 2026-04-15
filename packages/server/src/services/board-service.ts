import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import type {
  AccountAgent,
  AgentRole,
  AgentTeam,
  AppState,
  CoordinatorProposal,
  CreateAgentBody,
  CreateTaskBody,
  CreateTeamBody,
  CreateWorkspaceBody,
  DeleteResult,
  GlobalSettings,
  HealthCodexQuotaData,
  ListTasksQuery,
  ListProposalsQuery,
  MountAgentBody,
  PostTaskMessageBody,
  Run,
  RunnerConfig,
  StartTaskBody,
  TaskInputBody,
  Task,
  TaskMessage,
  TaskPullRequest,
  TaskWorktree,
  TeamAgent,
  TeamMessage,
  UpdateAgentBody,
  UpdateAgentRoleBody,
  UpdateSettingsBody,
  UpdateTaskBody,
  UpdateTeamBody,
  UpdateWorkspaceBody,
  UpdateWorkspaceConfigBody,
  WorkspaceAgent,
  WorkspaceGitRef,
  Workspace
} from "@workhorse/contracts";
import {
  resolveTemplate,
  resolveWorkspacePromptTemplate
} from "@workhorse/contracts";

import { AppError, ensure } from "../lib/errors.js";
import {
  GhCliPullRequestProvider,
  type GitHubPullRequestProvider
} from "../lib/github.js";
import { resolveWorkspaceCodexSettings } from "../lib/codex-settings.js";
import { createId } from "../lib/id.js";
import { parseUnifiedDiff, type DiffFile } from "../lib/diff-parser.js";
import { createRunLogEntry } from "../lib/run-log.js";
import { createTaskWorktree, deriveTeamSubtaskBranchName } from "../lib/task-worktree.js";
import { resolveGlobalSettings } from "../lib/global-settings.js";
import { resolveWorkspacePromptTemplates } from "../lib/workspace-prompt-templates.js";
import { StateStore } from "../persistence/state-store.js";
import {
  CodexAppServerManager,
  type CodexAppServer
} from "../runners/codex-app-server-manager.js";
import { CodexAcpRunner } from "../runners/codex-acp-runner.js";
import { ClaudeCliRunner } from "../runners/claude-cli-runner.js";
import type { RunnerAdapter } from "../runners/types.js";
import { ShellRunner } from "../runners/shell-runner.js";
import { EventBus } from "../ws/event-bus.js";
import { DependencyGraph } from "./dependency-graph.js";
import { GitWorktreeService } from "./git-worktree-service.js";
import {
  OpenRouterTaskIdentityGenerator,
  type TaskIdentityGenerator
} from "./openrouter-task-naming-service.js";
import {
  buildTaskPullRequestSummary,
  taskPullRequestEquals
} from "./pull-request-snapshot.js";
import {
  PrMonitorService,
  type GitReviewMonitorResult
} from "./pr-monitor-service.js";
import { AiReviewService } from "./ai-review-service.js";
import {
  NativeWorkspaceRootPicker,
  type WorkspaceRootPicker
} from "./workspace-root-picker.js";
import { RunLifecycleService, type StartTaskOptions } from "./run-lifecycle-service.js";
import { TaskScheduler } from "./task-scheduler.js";
import {
  CoordinatorSubtaskParseError,
  buildCoordinatorPrompt,
  buildSubtaskPrompt,
  buildTeamAgentMessageEvent,
  buildTeamTaskCreatedEvent,
  parseCoordinatorSubtasks,
  truncateTeamMessagePayload,
  type TeamAgentContext
} from "./team-coordinator-service.js";
import {
  buildSubtaskArtifactPayload,
  buildSubtaskStatusPayload
} from "./team-subtask-service.js";
import { TeamPrService, type PrCreator } from "./team-pr-service.js";

interface BoardServiceDependencies {
  gitWorktrees?: GitWorktreeService;
  githubPullRequests?: GitHubPullRequestProvider;
  codexAppServer?: CodexAppServer;
  taskIdentityGenerator?: TaskIdentityGenerator;
  workspaceRootPicker?: WorkspaceRootPicker;
  runners?: Record<string, RunnerAdapter>;
  prCreator?: PrCreator;
}

export type { GitReviewMonitorResult } from "./pr-monitor-service.js";

function validateTeamAgents(agents: TeamAgent[]): void {
  const coordinators = agents.filter((a) => a.role === "coordinator");
  if (coordinators.length !== 1) {
    throw new AppError(
      400,
      "INVALID_TEAM_AGENTS",
      `Team must have exactly 1 coordinator, got ${coordinators.length}`
    );
  }
}

const COLUMN_ORDER: Record<Task["column"], number> = {
  backlog: 0,
  todo: 1,
  blocked: 2,
  running: 3,
  review: 4,
  done: 5,
  archived: 6
};

export class BoardService {
  private readonly store: StateStore;

  private readonly events: EventBus;

  private readonly runners: Record<string, RunnerAdapter>;

  private readonly gitWorktrees: GitWorktreeService;

  private readonly githubPullRequests: GitHubPullRequestProvider;

  private readonly codexAppServer: CodexAppServer;

  private readonly taskIdentityGenerator: TaskIdentityGenerator;

  private readonly workspaceRootPicker: WorkspaceRootPicker;

  private readonly runLifecycle: RunLifecycleService;

  private readonly scheduler: TaskScheduler;

  private readonly prMonitor: PrMonitorService;

  private readonly teamPrService: TeamPrService;

  private readonly aiReview: AiReviewService;

  public constructor(
    store: StateStore,
    events: EventBus,
    dependencies: BoardServiceDependencies = {}
  ) {
    this.store = store;
    this.events = events;
    this.codexAppServer = dependencies.codexAppServer ?? new CodexAppServerManager();
    this.runners = dependencies.runners ?? {
      claude: new ClaudeCliRunner(),
      shell: new ShellRunner(),
      codex: new CodexAcpRunner(this.codexAppServer)
    };
    this.gitWorktrees = dependencies.gitWorktrees ?? new GitWorktreeService();
    this.githubPullRequests =
      dependencies.githubPullRequests ?? new GhCliPullRequestProvider();
    this.taskIdentityGenerator =
      dependencies.taskIdentityGenerator ?? new OpenRouterTaskIdentityGenerator();
    this.workspaceRootPicker =
      dependencies.workspaceRootPicker ?? new NativeWorkspaceRootPicker();
    this.aiReview = new AiReviewService({
      store: this.store,
      events: this.events,
      gitWorktrees: this.gitWorktrees,
      githubPullRequests: this.githubPullRequests,
      startTask: (taskId, opts) =>
        this.startTaskInternal(taskId, {
          ...opts,
          skipDependencyCheck: true
        }),
      appendAndPublishRunOutput: (taskId, runId, entry) => this.runLifecycle.appendAndPublishRunOutput(taskId, runId, entry),
      updateRunMetadata: (runId, metadata) => this.runLifecycle.updateRunMetadata(runId, metadata),
      refreshPullRequestSnapshot: (task, workspace) => this.refreshTaskPullRequestSnapshotForReview(task, workspace),
      getSettings: () => this.getSettings(),
      topOrder: (column, excludingId) => this.topOrder(column, excludingId)
    });
    this.runLifecycle = new RunLifecycleService({
      store: this.store,
      events: this.events,
      runners: () => this.runners,
      gitWorktrees: () => this.gitWorktrees,
      codexAppServer: this.codexAppServer,
      aiReview: this.aiReview,
      requireTask: (taskId, source) => this.requireTask(taskId, source),
      requireWorkspace: (workspaceId) => this.requireWorkspace(workspaceId),
      requireRun: (runId, source) => this.requireRun(runId, source),
      topOrder: (column, excludingId) => this.topOrder(column, excludingId),
      canTaskStart: (task, source) => this.canTaskStart(task, source),
      evaluateScheduler: () => this.scheduler.evaluate(),
      afterRunFinished: (task, run) => this.handleTeamRunFinished(task, run)
    });
    this.scheduler = new TaskScheduler(
      () => ({
        maxConcurrent: this.store.getSettings().scheduler?.maxConcurrent ?? 3,
        maxPerRunner: {
          codex: 1
        }
      }),
      {
        store: this.store,
        events: this.events,
        lifecycle: {
          startTask: (taskId, options) => this.startTaskInternal(taskId, options),
          isActive: (taskId) => this.runLifecycle.isActive(taskId),
          activeCount: () => this.runLifecycle.activeCount(),
          activeCountByRunner: (type) => this.runLifecycle.activeCountByRunner(type)
        }
      }
    );
    this.prMonitor = new PrMonitorService({
      store: this.store,
      events: this.events,
      gitWorktrees: this.gitWorktrees,
      githubPullRequests: this.githubPullRequests,
      startTask: (taskId, opts) =>
        this.startTaskInternal(taskId, {
          ...opts,
          skipDependencyCheck: true
        }),
      updateTask: (taskId, input) => this.updateTask(taskId, input),
      syncPullRequestSnapshot: (taskId, next) =>
        this.syncTaskPullRequestSnapshot(taskId, next),
      isTaskActive: (taskId) => this.runLifecycle.isActive(taskId),
      topOrder: (column, excludingId) => this.topOrder(column, excludingId)
    });
    this.teamPrService = new TeamPrService(
      this.store,
      this.events,
      dependencies.prCreator
    );
  }

  private requireTask(taskId: string, source?: Task[]): Task {
    return ensure(
      (source ?? this.store.listTasks()).find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );
  }

  private requireWorkspace(workspaceId: string, source?: Workspace[]): Workspace {
    return ensure(
      (source ?? this.store.listWorkspaces()).find((entry) => entry.id === workspaceId),
      404,
      "WORKSPACE_NOT_FOUND",
      "Workspace not found"
    );
  }

  private requireRun(runId: string, source?: Run[]): Run {
    return ensure(
      (source ?? this.store.listRuns()).find((entry) => entry.id === runId),
      404,
      "RUN_NOT_FOUND",
      "Run not found"
    );
  }

  private canTaskStart(task: Task, source?: Task[]): boolean {
    return this.scheduler.canStart(task, source ?? this.store.listTasks());
  }

  private async startTaskInternal(
    taskId: string,
    options: StartTaskOptions = {}
  ): Promise<{ task: Task; run: Run }> {
    const task = this.requireTask(taskId);
    const teamOptions =
      options.runnerConfigOverride != null
        ? undefined
        : this.resolveTeamStartOptions(task);

    return this.runLifecycle.startTask(taskId, {
      ...options,
      runnerConfigOverride: teamOptions?.runnerConfigOverride ?? options.runnerConfigOverride,
      runMetadata: {
        ...(teamOptions?.runMetadata ?? {}),
        ...(options.runMetadata ?? {})
      }
    });
  }

  private resolveTeamStartOptions(task: Task): Pick<
    StartTaskOptions,
    "runnerConfigOverride" | "runMetadata"
  > | undefined {
    if (task.teamId) {
      const team = this.getTeam(task.teamId);
      return task.parentTaskId
        ? this.buildSubtaskStartOptions(task, team)
        : this.buildCoordinatorStartOptions(task, team);
    }

    if (task.parentTaskId) {
      // Workspace-agent subtask path (parentTaskId set, no teamId)
      const workspace = this.requireWorkspace(task.workspaceId);
      const agents = this.store.listWorkspaceAgents(task.workspaceId);
      return this.buildSubtaskStartOptionsWs(task, agents, workspace);
    }

    // Check if workspace has a coordinator agent → workspace coordinator path
    const agents = this.store.listWorkspaceAgents(task.workspaceId);
    const coordinator = agents.find((a) => a.role === "coordinator");
    if (!coordinator) {
      return undefined;
    }
    return this.buildCoordinatorStartOptionsWs(task, agents);
  }

  private buildCoordinatorStartOptions(
    task: Task,
    team: AgentTeam
  ): Pick<StartTaskOptions, "runnerConfigOverride" | "runMetadata"> {
    const coordinator = this.resolveCoordinatorAgent(team);
    const userPromptParts = [
      this.extractRunnerPrompt(coordinator.runnerConfig),
      this.resolveUserTaskPrompt(task)
    ].filter((value): value is string => Boolean(value?.trim()));
    const prompt = buildCoordinatorPrompt({
      agents: this.buildTeamAgentContexts(team),
      userPrompt: userPromptParts.join("\n\n")
    });

    return {
      runnerConfigOverride: this.withRunnerPrompt(coordinator.runnerConfig, prompt),
      runMetadata: {
        trigger: "team_coordinator",
        teamId: team.id,
        teamAgentId: coordinator.id,
        parentTaskId: task.id
      }
    };
  }

  private buildSubtaskStartOptions(
    task: Task,
    team: AgentTeam
  ): Pick<StartTaskOptions, "runnerConfigOverride" | "runMetadata"> {
    const parentTaskId = ensure(
      task.parentTaskId,
      400,
      "TEAM_TASK_INVALID",
      "Subtask is missing parentTaskId"
    );
    const assignedAgent = this.resolveAssignedTeamAgent(team, task);
    const parentTask = this.requireTask(parentTaskId);
    const prompt = buildSubtaskPrompt({
      teamName: team.name,
      parentTaskTitle: parentTask.title,
      agents: this.buildTeamAgentContexts(team),
      messages: this.store.listTeamMessages(team.id, parentTaskId).map((message) => ({
        fromAgentId: message.agentName,
        messageType: message.messageType,
        payload: message.content
      })),
      subtaskTitle: task.title,
      subtaskDescription: task.description,
      userPrompt:
        this.extractRunnerPrompt(assignedAgent.runnerConfig) ??
        "Complete the assigned subtask and report concrete results."
    });

    return {
      runnerConfigOverride: this.withRunnerPrompt(assignedAgent.runnerConfig, prompt),
      runMetadata: {
        trigger: "team_subtask",
        teamId: team.id,
        teamAgentId: assignedAgent.id,
        parentTaskId
      }
    };
  }

  private buildCoordinatorStartOptionsWs(
    task: Task,
    agents: WorkspaceAgent[]
  ): Pick<StartTaskOptions, "runnerConfigOverride" | "runMetadata"> {
    const coordinator = this.resolveCoordinator(agents);
    const userPromptParts = [
      this.extractRunnerPrompt(coordinator.runnerConfig),
      this.resolveUserTaskPrompt(task)
    ].filter((value): value is string => Boolean(value?.trim()));
    const prompt = buildCoordinatorPrompt({
      agents: this.buildAgentContexts(agents),
      userPrompt: userPromptParts.join("\n\n")
    });

    return {
      runnerConfigOverride: this.withRunnerPrompt(coordinator.runnerConfig, prompt),
      runMetadata: {
        trigger: "team_coordinator",
        workspaceId: task.workspaceId,
        teamAgentId: coordinator.id,
        parentTaskId: task.id
      }
    };
  }

  private buildSubtaskStartOptionsWs(
    task: Task,
    agents: WorkspaceAgent[],
    workspace: Workspace
  ): Pick<StartTaskOptions, "runnerConfigOverride" | "runMetadata"> {
    const parentTaskId = ensure(
      task.parentTaskId,
      400,
      "TEAM_TASK_INVALID",
      "Subtask is missing parentTaskId"
    );
    const assignedAgent = this.resolveAssignedAgent(agents, task);
    const parentTask = this.requireTask(parentTaskId);
    const prompt = buildSubtaskPrompt({
      workspaceName: workspace.name,
      parentTaskTitle: parentTask.title,
      agents: this.buildAgentContexts(agents),
      messages: this.store.listTaskMessages(parentTaskId).map((message) => ({
        fromAgentId: message.agentName,
        messageType: message.messageType,
        payload: message.content
      })),
      subtaskTitle: task.title,
      subtaskDescription: task.description,
      userPrompt:
        this.extractRunnerPrompt(assignedAgent.runnerConfig) ??
        "Complete the assigned subtask and report concrete results."
    });

    return {
      runnerConfigOverride: this.withRunnerPrompt(assignedAgent.runnerConfig, prompt),
      runMetadata: {
        trigger: "team_subtask",
        workspaceId: task.workspaceId,
        teamAgentId: assignedAgent.id,
        parentTaskId
      }
    };
  }

  private buildAgentContexts(agents: WorkspaceAgent[]): TeamAgentContext[] {
    return agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      runnerType: agent.runnerConfig.type,
      description: agent.description
    }));
  }

  private resolveCoordinator(agents: WorkspaceAgent[]): WorkspaceAgent {
    const coordinator = agents.find((a) => a.role === "coordinator");
    return ensure(
      coordinator,
      400,
      "TEAM_COORDINATOR_MISSING",
      "Workspace must have exactly one coordinator agent"
    );
  }

  private resolveAssignedAgent(agents: WorkspaceAgent[], task: Task): WorkspaceAgent {
    const teamAgentId = ensure(
      task.teamAgentId,
      400,
      "TEAM_TASK_INVALID",
      "Subtask is missing teamAgentId"
    );
    const agent = agents.find((a) => a.id === teamAgentId);
    return ensure(
      agent,
      404,
      "TEAM_AGENT_NOT_FOUND",
      `Assigned workspace agent not found: ${teamAgentId}`
    );
  }

  private buildTeamAgentContexts(team: AgentTeam): TeamAgentContext[] {
    return team.agents.map((agent) => ({
      id: agent.id,
      name: agent.agentName,
      role: agent.role,
      runnerType: agent.runnerConfig.type
    }));
  }

  private resolveCoordinatorAgent(team: AgentTeam): TeamAgent {
    const coordinator = team.agents.find((agent) => agent.role === "coordinator");
    return ensure(
      coordinator,
      400,
      "TEAM_COORDINATOR_MISSING",
      "Team must have exactly one coordinator"
    );
  }

  private resolveAssignedTeamAgent(team: AgentTeam, task: Task): TeamAgent {
    const teamAgentId = ensure(
      task.teamAgentId,
      400,
      "TEAM_TASK_INVALID",
      "Subtask is missing teamAgentId"
    );
    const agent = team.agents.find((entry) => entry.id === teamAgentId);
    return ensure(
      agent,
      404,
      "TEAM_AGENT_NOT_FOUND",
      `Assigned team agent not found: ${teamAgentId}`
    );
  }

  private extractRunnerPrompt(runnerConfig: RunnerConfig): string | undefined {
    if (runnerConfig.type === "codex" || runnerConfig.type === "claude") {
      const prompt = runnerConfig.prompt.trim();
      return prompt ? prompt : undefined;
    }

    return undefined;
  }

  private resolveUserTaskPrompt(task: Task): string {
    const parts = [task.description.trim(), this.extractRunnerPrompt(task.runnerConfig)].filter(
      (value): value is string => Boolean(value?.trim())
    );
    return parts.length > 0 ? parts.join("\n\n") : task.title;
  }

  private withRunnerPrompt(runnerConfig: RunnerConfig, prompt: string): RunnerConfig {
    if (runnerConfig.type === "codex" || runnerConfig.type === "claude") {
      return {
        ...runnerConfig,
        prompt
      };
    }

    throw new AppError(
      400,
      "TEAM_AGENT_RUNNER_NOT_SUPPORTED",
      "Agent team execution currently requires codex or claude runners"
    );
  }

  private async handleTeamRunFinished(task: Task, run: Run): Promise<void> {
    const isWorkspacePath =
      !task.teamId && Boolean(run.metadata?.workspaceId);
    if (!task.teamId && !isWorkspacePath) {
      return;
    }

    if (task.parentTaskId) {
      await this.handleSubtaskRunFinished(task, run);
      return;
    }

    if (run.status !== "succeeded" || run.metadata?.trigger !== "team_coordinator") {
      return;
    }

    if (task.teamId) {
      // Legacy team path
      try {
        const team = this.getTeam(task.teamId);
        const output = await this.extractCoordinatorOutput(run.id);
        const drafts = parseCoordinatorSubtasks(output);

        // C1: cancel any existing pending proposal so only the latest is awaiting approval.
        const existingPending = this.store
          .listProposals(team.id, task.id)
          .find((p) => p.status === "pending");
        if (existingPending) {
          this.store.updateProposalStatus(
            existingPending.id,
            "rejected",
            new Date().toISOString()
          );
        }

        const proposal: CoordinatorProposal = {
          id: createId(),
          teamId: team.id,
          parentTaskId: task.id,
          status: "pending",
          drafts,
          createdAt: new Date().toISOString()
        };
        this.store.saveProposal(proposal);

        this.events.publish({
          type: "team.proposal.created",
          teamId: team.id,
          parentTaskId: task.id,
          proposal
        });
      } catch (error) {
        await this.restoreCoordinatorParentToReview(task.id);
        const message =
          error instanceof Error ? error.message : "Coordinator output could not be processed";
        await this.runLifecycle.appendAndPublishRunOutput(
          task.id,
          run.id,
          createRunLogEntry(run.id, {
            kind: "system",
            stream: "system",
            title: "Coordinator parse error",
            text: `${message}\n`
          })
        );
      }
    } else {
      // Workspace-agent path
      const workspaceId = ensure(
        run.metadata?.workspaceId,
        500,
        "MISSING_WORKSPACE_ID",
        "Run metadata missing workspaceId in workspace coordinator path"
      );
      try {
        const output = await this.extractCoordinatorOutput(run.id);
        const drafts = parseCoordinatorSubtasks(output);

        const existingPending = this.store
          .listProposalsByWorkspace(workspaceId, task.id)
          .find((p) => p.status === "pending");
        if (existingPending) {
          this.store.updateProposalStatus(
            existingPending.id,
            "rejected",
            new Date().toISOString()
          );
        }

        const proposal: CoordinatorProposal = {
          id: createId(),
          teamId: null,
          workspaceId,
          parentTaskId: task.id,
          status: "pending",
          drafts,
          createdAt: new Date().toISOString()
        };
        this.store.saveProposal(proposal);

        // HACK: reuse teamId field for workspaceId until PR-D event rename
        this.events.publish({
          type: "team.proposal.created",
          teamId: workspaceId,
          parentTaskId: task.id,
          proposal
        });
      } catch (error) {
        await this.restoreCoordinatorParentToReview(task.id);
        const message =
          error instanceof Error ? error.message : "Coordinator output could not be processed";
        await this.runLifecycle.appendAndPublishRunOutput(
          task.id,
          run.id,
          createRunLogEntry(run.id, {
            kind: "system",
            stream: "system",
            title: "Coordinator parse error",
            text: `${message}\n`
          })
        );
      }
    }
  }

  private async restoreCoordinatorParentToReview(taskId: string): Promise<void> {
    const recoveredTask = await this.store.updateState((state) => {
      const taskIndex = state.tasks.findIndex((entry) => entry.id === taskId);
      if (taskIndex === -1) {
        return null;
      }

      const currentTask = state.tasks[taskIndex]!;
      if (currentTask.column !== "running") {
        return null;
      }

      currentTask.column = "review";
      currentTask.order = this.topOrderFromTasks("review", state.tasks, currentTask.id);
      currentTask.updatedAt = new Date().toISOString();
      return { ...currentTask };
    });

    if (!recoveredTask) {
      return;
    }

    try {
      this.events.publish({
        type: "task.updated",
        action: "updated",
        taskId: recoveredTask.id,
        task: recoveredTask
      });
    } catch {
      // Best-effort recovery notification. The persisted task state already reflects review.
    }
  }

  private async handleSubtaskRunFinished(task: Task, run: Run): Promise<void> {
    if (run.status !== "succeeded" && run.status !== "failed") {
      return;
    }
    if (task.cancelledAt) {
      return;
    }

    const now = new Date().toISOString();
    const parentTaskId = task.parentTaskId!;

    if (task.teamId) {
      // Legacy team path
      const team = this.getTeam(task.teamId);
      const agent = this.resolveAssignedTeamAgent(team, task);

      const statusPayload = buildSubtaskStatusPayload(task, run);
      this.publishTeamThreadMessage({
        teamId: team.id,
        parentTaskId,
        taskId: task.id,
        agentName: agent.agentName,
        fromAgentId: agent.id,
        senderType: "agent",
        messageType: "status",
        payload: statusPayload,
        createdAt: now
      });

      if (run.status === "succeeded") {
        try {
          const worktreePath = task.worktree.path;
          const diff =
            worktreePath && task.worktree.baseRef
              ? await this.gitWorktrees.getWorktreeDiff(worktreePath, task.worktree.baseRef)
              : "";
          const artifactPayload = buildSubtaskArtifactPayload({
            diff,
            pullRequestUrl: task.pullRequestUrl
          });
          this.publishTeamThreadMessage({
            teamId: team.id,
            parentTaskId,
            taskId: task.id,
            agentName: agent.agentName,
            fromAgentId: agent.id,
            senderType: "agent",
            messageType: "artifact",
            payload: artifactPayload,
            createdAt: now
          });
        } catch {
          // Best-effort: git diff not critical for team coordination
        }

        if (team.autoApproveSubtasks) {
          const doneTask = await this.store.updateState((state) => {
            const idx = state.tasks.findIndex((t) => t.id === task.id);
            if (idx === -1) return null;
            const entry = state.tasks[idx]!;
            if (entry.column !== "review") return null;
            entry.column = "done";
            entry.rejected = false;
            entry.order = this.nextOrderFromTasks("done", state.tasks);
            entry.updatedAt = new Date().toISOString();
            return { ...entry };
          });

          if (doneTask) {
            this.events.publish({
              type: "task.updated",
              action: "updated",
              taskId: doneTask.id,
              task: doneTask
            });
            void this.teamPrService
              .createSubtaskPullRequest(doneTask, team)
              .catch((err) => {
                console.error("TeamPrService.createSubtaskPullRequest failed", err);
              });
          }
        }
      } else if (team.autoApproveSubtasks) {
        const doneTask = await this.store.updateState((state) => {
          const idx = state.tasks.findIndex((t) => t.id === task.id);
          if (idx === -1) return null;
          const entry = state.tasks[idx]!;
          if (entry.column !== "review") return null;
          entry.column = "done";
          entry.rejected = true;
          entry.order = this.nextOrderFromTasks("done", state.tasks);
          entry.updatedAt = new Date().toISOString();
          return { ...entry };
        });

        if (doneTask) {
          this.events.publish({
            type: "task.updated",
            action: "updated",
            taskId: doneTask.id,
            task: doneTask
          });
        }
      }

      await this.checkAndHandleTeamCompletion(parentTaskId, team.id);
    } else {
      // Workspace-agent path
      const workspace = this.requireWorkspace(task.workspaceId);
      const agents = this.store.listWorkspaceAgents(task.workspaceId);
      const agent = this.resolveAssignedAgent(agents, task);

      const statusPayload = buildSubtaskStatusPayload(task, run);
      this.publishTeamThreadMessage({
        workspaceId: task.workspaceId,
        parentTaskId,
        taskId: task.id,
        agentName: agent.name,
        fromAgentId: agent.id,
        senderType: "agent",
        messageType: "status",
        payload: statusPayload,
        createdAt: now
      });

      if (run.status === "succeeded") {
        try {
          const worktreePath = task.worktree.path;
          const diff =
            worktreePath && task.worktree.baseRef
              ? await this.gitWorktrees.getWorktreeDiff(worktreePath, task.worktree.baseRef)
              : "";
          const artifactPayload = buildSubtaskArtifactPayload({
            diff,
            pullRequestUrl: task.pullRequestUrl
          });
          this.publishTeamThreadMessage({
            workspaceId: task.workspaceId,
            parentTaskId,
            taskId: task.id,
            agentName: agent.name,
            fromAgentId: agent.id,
            senderType: "agent",
            messageType: "artifact",
            payload: artifactPayload,
            createdAt: now
          });
        } catch {
          // Best-effort: git diff not critical for workspace coordination
        }

        if (workspace.autoApproveSubtasks) {
          const doneTask = await this.store.updateState((state) => {
            const idx = state.tasks.findIndex((t) => t.id === task.id);
            if (idx === -1) return null;
            const entry = state.tasks[idx]!;
            if (entry.column !== "review") return null;
            entry.column = "done";
            entry.rejected = false;
            entry.order = this.nextOrderFromTasks("done", state.tasks);
            entry.updatedAt = new Date().toISOString();
            return { ...entry };
          });

          if (doneTask) {
            this.events.publish({
              type: "task.updated",
              action: "updated",
              taskId: doneTask.id,
              task: doneTask
            });
            void this.teamPrService
              .createSubtaskPullRequest(doneTask, { prStrategy: workspace.prStrategy ?? "independent" })
              .catch((err) => {
                console.error("TeamPrService.createSubtaskPullRequest failed", err);
              });
          }
        }
      } else if (workspace.autoApproveSubtasks) {
        const doneTask = await this.store.updateState((state) => {
          const idx = state.tasks.findIndex((t) => t.id === task.id);
          if (idx === -1) return null;
          const entry = state.tasks[idx]!;
          if (entry.column !== "review") return null;
          entry.column = "done";
          entry.rejected = true;
          entry.order = this.nextOrderFromTasks("done", state.tasks);
          entry.updatedAt = new Date().toISOString();
          return { ...entry };
        });

        if (doneTask) {
          this.events.publish({
            type: "task.updated",
            action: "updated",
            taskId: doneTask.id,
            task: doneTask
          });
        }
      }

      await this.checkAndHandleTeamCompletion(parentTaskId, null);
    }
  }

  private async checkAndHandleTeamCompletion(
    parentTaskId: string,
    teamId: string | null
  ): Promise<void> {
    const result = await this.store.updateState((state) => {
      const subtasks = state.tasks.filter(
        teamId !== null
          ? (t) => t.parentTaskId === parentTaskId && t.teamId === teamId
          : (t) => t.parentTaskId === parentTaskId && !t.teamId
      );
      if (subtasks.length === 0) {
        return null;
      }

      // Human-in-the-loop teams only aggregate once every subtask reaches a
      // terminal column. Review subtasks remain pending until a human approves,
      // rejects, or retries them. Fully automatic teams convert review results
      // to done/rejected earlier in handleSubtaskRunFinished().
      if (subtasks.some((t) => t.column !== "done")) {
        return null;
      }

      const parentIndex = state.tasks.findIndex((t) => t.id === parentTaskId);
      if (parentIndex === -1) {
        return null;
      }

      const parent = state.tasks[parentIndex]!;
      if (parent.column !== "running") {
        return null;
      }

      const now = new Date().toISOString();
      parent.column = "review";
      parent.order = this.topOrderFromTasks("review", state.tasks, parent.id);
      parent.updatedAt = now;

      return {
        parent: { ...parent },
        subtasks: subtasks.map((t) => ({ ...t }))
      };
    });

    if (!result) {
      return;
    }

    const now = new Date().toISOString();
    const hasFinalizedExceptions = result.subtasks.some(
      (task) => task.rejected || Boolean(task.cancelledAt)
    );
    const summaryLines = [
      hasFinalizedExceptions
        ? "All subtasks reached a final decision:"
        : "All subtasks completed successfully:",
      ...result.subtasks.map((t) => {
        const suffix = t.cancelledAt ? " (cancelled)" : t.rejected ? " (rejected)" : "";
        return `- ${t.title}${suffix}`;
      })
    ];
    const payload = truncateTeamMessagePayload(summaryLines.join("\n"));
    if (teamId !== null) {
      this.publishTeamThreadMessage({
        teamId,
        parentTaskId,
        taskId: parentTaskId,
        agentName: "system",
        fromAgentId: "system",
        senderType: "system",
        messageType: "status",
        payload,
        createdAt: now
      });
    } else {
      // Workspace path: use the parent task's workspaceId
      const parentTask = this.requireTask(parentTaskId);
      this.publishTeamThreadMessage({
        workspaceId: parentTask.workspaceId,
        parentTaskId,
        taskId: parentTaskId,
        agentName: "system",
        fromAgentId: "system",
        senderType: "system",
        messageType: "status",
        payload,
        createdAt: now
      });
    }
    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: result.parent.id,
      task: result.parent
    });
  }

  private publishTeamThreadMessage(input: {
    teamId?: string;
    workspaceId?: string;
    parentTaskId: string;
    taskId?: string;
    agentName: string;
    fromAgentId: string;
    senderType: TeamMessage["senderType"];
    messageType: TeamMessage["messageType"];
    payload: string;
    createdAt?: string;
  }): void {
    const createdAt = input.createdAt ?? new Date().toISOString();

    if (input.workspaceId) {
      // Workspace-agent path: write to task_messages
      const item: TaskMessage = {
        id: createId(),
        parentTaskId: input.parentTaskId,
        taskId: input.taskId,
        agentName: input.agentName,
        senderType: input.senderType,
        messageType: input.messageType,
        content: input.payload,
        createdAt
      };
      this.store.appendTaskMessage(item);
      // HACK: reuse teamId field for workspaceId until PR-D event rename
      this.events.publish(
        buildTeamAgentMessageEvent({
          teamId: input.workspaceId,
          parentTaskId: input.parentTaskId,
          fromAgentId: input.fromAgentId,
          messageType: input.messageType,
          payload: input.payload
        })
      );
    } else {
      // Legacy team path: write to team_messages
      const teamId = input.teamId!;
      const item: TeamMessage = {
        id: createId(),
        teamId,
        parentTaskId: input.parentTaskId,
        taskId: input.taskId,
        agentName: input.agentName,
        senderType: input.senderType,
        messageType: input.messageType,
        content: input.payload,
        createdAt
      };
      this.store.appendTeamMessage(item);
      this.events.publish(
        buildTeamAgentMessageEvent({
          teamId,
          parentTaskId: input.parentTaskId,
          fromAgentId: input.fromAgentId,
          messageType: input.messageType,
          payload: input.payload
        })
      );
    }
  }

  private async extractCoordinatorOutput(runId: string): Promise<string> {
    const entries = await this.store.readLogEntries(runId);
    const lastAgentEntry = [...entries].reverse().find((entry) => entry.kind === "agent");
    return ensure(
      lastAgentEntry?.text.trim(),
      400,
      "TEAM_COORDINATOR_OUTPUT_MISSING",
      "Coordinator run did not produce a final agent output"
    );
  }

  private async createCoordinatorSubtasks(
    parentTask: Task,
    team: AgentTeam,
    drafts: ReturnType<typeof parseCoordinatorSubtasks>
  ): Promise<{ parentTask: Task; subtasks: Task[] }> {
    const workspace = this.requireWorkspace(parentTask.workspaceId);
    const existingTasks = this.store.listTasks();
    if (existingTasks.some((task) => task.parentTaskId === parentTask.id)) {
      throw new CoordinatorSubtaskParseError(
        "Parent task already has subtasks; refusing to create duplicates"
      );
    }

    const agentBuckets = new Map<string, TeamAgent[]>();
    for (const agent of team.agents) {
      const bucket = agentBuckets.get(agent.agentName) ?? [];
      bucket.push(agent);
      agentBuckets.set(agent.agentName, bucket);
    }

    const titleToId = new Map<string, string>();
    const draftAssignments = drafts.map((draft) => {
      const matches = agentBuckets.get(draft.assignedAgent) ?? [];
      if (matches.length === 0) {
        throw new CoordinatorSubtaskParseError(
          `Coordinator assigned unknown agent "${draft.assignedAgent}"`
        );
      }
      if (matches.length > 1) {
        throw new CoordinatorSubtaskParseError(
          `Coordinator assigned ambiguous agent "${draft.assignedAgent}"`
        );
      }
      if (titleToId.has(draft.title)) {
        throw new CoordinatorSubtaskParseError(
          `Coordinator emitted duplicate subtask title "${draft.title}"`
        );
      }
      const taskId = createId();
      titleToId.set(draft.title, taskId);
      return {
        draft,
        agent: matches[0]!,
        taskId
      };
    });

    const createdAt = new Date().toISOString();
    return this.store.updateState((state) => {
      const parentIndex = state.tasks.findIndex((task) => task.id === parentTask.id);
      if (parentIndex === -1) {
        throw new AppError(404, "TASK_NOT_FOUND", "Parent team task not found");
      }

      const plannedSubtasks = draftAssignments.map(({ draft, agent, taskId }, index) => {
        const dependencyIds = draft.dependencies.map((dependencyTitle) => {
          const dependencyId = titleToId.get(dependencyTitle);
          if (!dependencyId) {
            throw new CoordinatorSubtaskParseError(
              `Coordinator referenced unknown dependency "${dependencyTitle}"`
            );
          }
          return dependencyId;
        });

        return {
          id: taskId,
          title: draft.title,
          description: draft.description,
          workspaceId: workspace.id,
          column: "todo",
          order: this.nextOrderFromTasks("todo", state.tasks, index),
          runnerType: agent.runnerConfig.type,
          runnerConfig: agent.runnerConfig,
          dependencies: dependencyIds,
          worktree: createTaskWorktree(taskId, draft.title, {
            workspace,
            baseRef: workspace.isGitRepo ? parentTask.worktree.baseRef : undefined,
            branchName: workspace.isGitRepo
              ? deriveTeamSubtaskBranchName(team.id, taskId, draft.title)
              : undefined
          }),
          teamId: team.id,
          parentTaskId: parentTask.id,
          teamAgentId: agent.id,
          rejected: false,
          createdAt,
          updatedAt: createdAt
        } satisfies Task;
      });

      const cycle = DependencyGraph.fromTasks([...state.tasks, ...plannedSubtasks]).detectCycle();
      if (cycle) {
        throw new CoordinatorSubtaskParseError(
          `Coordinator emitted circular subtask dependencies: ${cycle.join(" -> ")}`
        );
      }

      state.tasks.push(...plannedSubtasks);
      const parent = state.tasks[parentIndex]!;
      parent.column = "running";
      parent.order = this.topOrderFromTasks("running", state.tasks, parent.id);
      parent.updatedAt = createdAt;

      return {
        parentTask: { ...parent },
        subtasks: plannedSubtasks.map((task) => ({ ...task }))
      };
    });
  }

  private buildCoordinatorSummary(
    subtasks: Task[],
    resolveAgentName: (subtask: Task) => string
  ): string {
    const lines = ["Coordinator created subtasks:"];
    for (const subtask of subtasks) {
      const agentName = resolveAgentName(subtask);
      const dependencySummary =
        subtask.dependencies.length > 0
          ? ` (depends on ${subtask.dependencies.length} task${subtask.dependencies.length === 1 ? "" : "s"})`
          : "";
      lines.push(`- ${subtask.title} -> ${agentName}${dependencySummary}`);
    }
    return lines.join("\n");
  }

  private async createCoordinatorSubtasksWs(
    parentTask: Task,
    agents: WorkspaceAgent[],
    workspace: Workspace,
    drafts: ReturnType<typeof parseCoordinatorSubtasks>
  ): Promise<{ parentTask: Task; subtasks: Task[] }> {
    const existingTasks = this.store.listTasks();
    if (existingTasks.some((task) => task.parentTaskId === parentTask.id)) {
      throw new CoordinatorSubtaskParseError(
        "Parent task already has subtasks; refusing to create duplicates"
      );
    }

    const agentBuckets = new Map<string, WorkspaceAgent[]>();
    for (const agent of agents) {
      const bucket = agentBuckets.get(agent.name) ?? [];
      bucket.push(agent);
      agentBuckets.set(agent.name, bucket);
    }

    const titleToId = new Map<string, string>();
    const draftAssignments = drafts.map((draft) => {
      const matches = agentBuckets.get(draft.assignedAgent) ?? [];
      if (matches.length === 0) {
        throw new CoordinatorSubtaskParseError(
          `Coordinator assigned unknown agent "${draft.assignedAgent}"`
        );
      }
      if (matches.length > 1) {
        throw new CoordinatorSubtaskParseError(
          `Coordinator assigned ambiguous agent "${draft.assignedAgent}"`
        );
      }
      if (titleToId.has(draft.title)) {
        throw new CoordinatorSubtaskParseError(
          `Coordinator emitted duplicate subtask title "${draft.title}"`
        );
      }
      const taskId = createId();
      titleToId.set(draft.title, taskId);
      return {
        draft,
        agent: matches[0]!,
        taskId
      };
    });

    const createdAt = new Date().toISOString();
    return this.store.updateState((state) => {
      const parentIndex = state.tasks.findIndex((task) => task.id === parentTask.id);
      if (parentIndex === -1) {
        throw new AppError(404, "TASK_NOT_FOUND", "Parent coordinator task not found");
      }

      const plannedSubtasks = draftAssignments.map(({ draft, agent, taskId }, index) => {
        const dependencyIds = draft.dependencies.map((dependencyTitle) => {
          const dependencyId = titleToId.get(dependencyTitle);
          if (!dependencyId) {
            throw new CoordinatorSubtaskParseError(
              `Coordinator referenced unknown dependency "${dependencyTitle}"`
            );
          }
          return dependencyId;
        });

        return {
          id: taskId,
          title: draft.title,
          description: draft.description,
          workspaceId: workspace.id,
          column: "todo",
          order: this.nextOrderFromTasks("todo", state.tasks, index),
          runnerType: agent.runnerConfig.type,
          runnerConfig: agent.runnerConfig,
          dependencies: dependencyIds,
          worktree: createTaskWorktree(taskId, draft.title, {
            workspace,
            baseRef: workspace.isGitRepo ? parentTask.worktree.baseRef : undefined,
            branchName: workspace.isGitRepo
              ? deriveTeamSubtaskBranchName(workspace.id, taskId, draft.title)
              : undefined
          }),
          parentTaskId: parentTask.id,
          teamAgentId: agent.id,
          rejected: false,
          createdAt,
          updatedAt: createdAt
        } satisfies Task;
      });

      const cycle = DependencyGraph.fromTasks([...state.tasks, ...plannedSubtasks]).detectCycle();
      if (cycle) {
        throw new CoordinatorSubtaskParseError(
          `Coordinator emitted circular subtask dependencies: ${cycle.join(" -> ")}`
        );
      }

      state.tasks.push(...plannedSubtasks);
      const parent = state.tasks[parentIndex]!;
      parent.column = "running";
      parent.order = this.topOrderFromTasks("running", state.tasks, parent.id);
      parent.updatedAt = createdAt;

      return {
        parentTask: { ...parent },
        subtasks: plannedSubtasks.map((task) => ({ ...task }))
      };
    });
  }

  private nextOrderFromTasks(
    column: Task["column"],
    tasks: Task[],
    offset = 0
  ): number {
    const columnTasks = tasks
      .filter((task) => task.column === column)
      .sort((left, right) => left.order - right.order);
    const last = columnTasks.at(-1);
    return (last ? last.order : 0) + (offset + 1) * 1_024;
  }

  private topOrderFromTasks(
    column: Task["column"],
    tasks: Task[],
    excludingTaskId?: string
  ): number {
    const columnTasks = tasks
      .filter((task) => task.column === column && task.id !== excludingTaskId)
      .sort((left, right) => left.order - right.order);
    const first = columnTasks[0];
    return first ? first.order - 1_024 : 1_024;
  }

  public async initialize(): Promise<void> {
    await this.store.load();
    await this.runLifecycle.recoverOrphanedRuns();
  }

  public async warmCodexAppServer(): Promise<void> {
    await this.codexAppServer.initialize();
  }

  public snapshot(): AppState {
    return this.store.snapshot();
  }

  public getReviewMonitorLastPolledAt(): string | undefined {
    return this.prMonitor.getLastPolledAt();
  }

  public getSettings(): GlobalSettings {
    return this.store.getSettings();
  }

  public async getCodexQuota(): Promise<HealthCodexQuotaData | null> {
    try {
      return await this.codexAppServer.readAccountRateLimits();
    } catch {
      return null;
    }
  }

  public async pickWorkspaceRootPath(): Promise<string | null> {
    return this.workspaceRootPicker.pickRootPath();
  }

  public listWorkspaces(): Workspace[] {
    return this.store
      .listWorkspaces()
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async updateSettings(input: UpdateSettingsBody): Promise<GlobalSettings> {
    const settings = resolveGlobalSettings(input);
    this.store.setSettings(settings);
    await this.store.save();
    return settings;
  }

  public async listWorkspaceGitRefs(workspaceId: string): Promise<WorkspaceGitRef[]> {
    const workspace = this.requireWorkspace(workspaceId);

    return this.gitWorktrees.listRefs(workspace);
  }

  public async getWorkspaceGitStatus(workspaceId: string) {
    const workspace = this.requireWorkspace(workspaceId);

    return this.gitWorktrees.getWorkspaceGitStatus(workspace);
  }

  public async pullWorkspace(workspaceId: string) {
    const workspace = this.requireWorkspace(workspaceId);

    await this.gitWorktrees.pullWorkspace(workspace);
    return { success: true };
  }

  public async createWorkspace(input: CreateWorkspaceBody): Promise<Workspace> {
    const name = input.name.trim();
    const rootPath = input.rootPath.trim();
    if (!name) {
      throw new AppError(400, "INVALID_WORKSPACE", "Workspace name is required");
    }
    await this.ensureReadableDirectory(rootPath);

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: createId(),
      name,
      rootPath,
      isGitRepo: await this.detectGitRepo(rootPath),
      codexSettings: resolveWorkspaceCodexSettings({
        codexSettings: input.codexSettings
      }),
      promptTemplates: resolveWorkspacePromptTemplates({
        promptTemplates: input.promptTemplates
      }),
      createdAt: now,
      updatedAt: now
    };

    const workspaces = [...this.store.listWorkspaces(), workspace];
    this.store.setWorkspaces(workspaces);
    await this.store.save();
    this.events.publish({
      type: "workspace.updated",
      action: "created",
      workspaceId: workspace.id,
      workspace
    });
    return workspace;
  }

  public async updateWorkspace(
    workspaceId: string,
    input: UpdateWorkspaceBody
  ): Promise<Workspace> {
    const workspaces = this.store.listWorkspaces();
    const workspace = this.requireWorkspace(workspaceId, workspaces);

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new AppError(400, "INVALID_WORKSPACE", "Workspace name is required");
      }
      workspace.name = name;
    }
    if (input.codexSettings !== undefined) {
      workspace.codexSettings = resolveWorkspaceCodexSettings({
        codexSettings: input.codexSettings
      });
    }
    if (input.promptTemplates !== undefined) {
      workspace.promptTemplates = resolveWorkspacePromptTemplates({
        promptTemplates: input.promptTemplates
      });
    }
    workspace.updatedAt = new Date().toISOString();

    this.store.setWorkspaces(workspaces);
    await this.store.save();
    this.events.publish({
      type: "workspace.updated",
      action: "updated",
      workspaceId: workspace.id,
      workspace
    });
    return workspace;
  }

  public async deleteWorkspace(workspaceId: string): Promise<DeleteResult> {
    const hasTasks = this.store.listTasks().some((task) => task.workspaceId === workspaceId);
    if (hasTasks) {
      throw new AppError(
        409,
        "WORKSPACE_HAS_TASKS",
        "Delete the workspace tasks before removing the workspace"
      );
    }

    const nextWorkspaces = this.store
      .listWorkspaces()
      .filter((workspace) => workspace.id !== workspaceId);
    if (nextWorkspaces.length === this.store.listWorkspaces().length) {
      throw new AppError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }

    this.store.setWorkspaces(nextWorkspaces);
    await this.store.save();
    this.events.publish({
      type: "workspace.updated",
      action: "deleted",
      workspaceId
    });
    return { id: workspaceId };
  }

  public getTask(taskId: string): Task {
    return this.requireTask(taskId);
  }

  public listTasks(query: ListTasksQuery): Task[] {
    return this.store
      .listTasks()
      .filter((task) =>
        query.workspaceId ? task.workspaceId === query.workspaceId : true
      )
      .sort((left, right) => {
        if (left.column !== right.column) {
          return COLUMN_ORDER[left.column] - COLUMN_ORDER[right.column];
        }
        return left.order - right.order;
      });
  }

  public async createTask(input: CreateTaskBody): Promise<Task> {
    const workspace = this.requireWorkspace(input.workspaceId);
    const team = input.teamId ? this.store.getTeam(input.teamId) : null;
    if (input.teamId && !team) {
      throw new AppError(
        400,
        "INVALID_TEAM",
        "The specified team does not exist"
      );
    }
    if (team && team.workspaceId !== workspace.id) {
      throw new AppError(
        400,
        "INVALID_TEAM",
        "Team must belong to the selected workspace"
      );
    }

    const description = input.description?.trim() ?? "";
    const providedTitle = input.title.trim();
    let title = providedTitle;
    let branchLabel: string | undefined;

    if (!title) {
      if (!description) {
        throw new AppError(
          400,
          "INVALID_TASK",
          "Task title or description is required"
        );
      }

      const generatedIdentity = await this.taskIdentityGenerator.generate({
        description,
        settings: this.store.getSettings()
      });
      title = generatedIdentity.title.trim();
      branchLabel = generatedIdentity.worktreeName.trim();
    }

    if (!title) {
      throw new AppError(400, "INVALID_TASK", "Task title is required");
    }
    const teamCoordinator = team?.agents.find((agent) => agent.role === "coordinator");
    if (team && !teamCoordinator) {
      throw new AppError(
        400,
        "INVALID_TEAM",
        "Team must have exactly 1 coordinator"
      );
    }
    // When no team is specified, check if the workspace has a coordinator agent.
    const wsCoordinator = !team
      ? this.store.listWorkspaceAgents(workspace.id).find((a) => a.role === "coordinator")
      : undefined;
    const coordinator = teamCoordinator ?? wsCoordinator;
    const runnerType = coordinator?.runnerConfig.type ?? input.runnerType;
    const runnerConfig = coordinator?.runnerConfig ?? input.runnerConfig;
    this.ensureRunnerConfig(runnerType, runnerConfig);
    const existingTasks = this.store.listTasks();
    const taskId = createId();
    const baseRef = workspace.isGitRepo
      ? await this.gitWorktrees.resolveBaseRef(workspace, input.worktreeBaseRef)
      : undefined;
    let worktree = createTaskWorktree(taskId, title, {
      workspace,
      branchLabel,
      baseRef
    });

    if (
      branchLabel &&
      existingTasks.some(
        (task) =>
          task.workspaceId === workspace.id &&
          task.worktree.branchName === worktree.branchName
      )
    ) {
      worktree = createTaskWorktree(taskId, title, {
        workspace,
        branchLabel,
        baseRef,
        preserveAutoTaskId: true
      });
    }

    const now = new Date().toISOString();
    const column = input.column ?? "backlog";
    const task: Task = {
      id: taskId,
      title,
      description,
      workspaceId: workspace.id,
      column,
      order: input.order ?? this.nextOrder(column),
      runnerType,
      runnerConfig,
      dependencies: [],
      worktree,
      rejected: false,
      teamId: team?.id,
      createdAt: now,
      updatedAt: now
    };

    const tasks = [...existingTasks, task];
    this.store.setTasks(tasks);
    await this.store.save();
    this.events.publish({
      type: "task.updated",
      action: "created",
      taskId: task.id,
      task
    });
    return task;
  }

  public async updateTask(taskId: string, input: UpdateTaskBody): Promise<Task> {
    const tasks = this.store.listTasks();
    const task = this.requireTask(taskId, tasks);
    const currentWorkspace = this.requireWorkspace(task.workspaceId);
    const nextWorkspace =
      input.workspaceId !== undefined
        ? this.requireWorkspace(input.workspaceId)
        : currentWorkspace;
    const workspaceChanged = nextWorkspace.id !== currentWorkspace.id;
    const previousColumn = task.column;

    if (
      workspaceChanged &&
      (task.worktree.status === "ready" || task.worktree.status === "cleanup_pending")
    ) {
      throw new AppError(
        409,
        "TASK_WORKTREE_ACTIVE",
        "Cleanup the task worktree before moving it to another workspace"
      );
    }

    if (input.runnerType || input.runnerConfig) {
      this.ensureRunnerConfig(
        input.runnerType ?? task.runnerType,
        input.runnerConfig ?? task.runnerConfig
      );
    }

    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) {
        throw new AppError(400, "INVALID_TASK", "Task title is required");
      }
      task.title = title;
    }

    if (workspaceChanged) {
      task.workspaceId = nextWorkspace.id;
      task.worktree = await this.resetTaskWorktree(task, nextWorkspace, input.worktreeBaseRef);
      task.pullRequestUrl = undefined;
      task.pullRequest = undefined;
    } else if (input.worktreeBaseRef !== undefined) {
      if (!nextWorkspace.isGitRepo) {
        throw new AppError(
          400,
          "TASK_WORKTREE_NOT_SUPPORTED",
          "Only Git workspaces support task worktrees"
        );
      }
      if (task.worktree.status === "ready" || task.worktree.status === "cleanup_pending") {
        throw new AppError(
          409,
          "TASK_WORKTREE_ACTIVE",
          "Cleanup the task worktree before changing its base ref"
        );
      }
      task.worktree = {
        ...task.worktree,
        baseRef: await this.gitWorktrees.resolveBaseRef(nextWorkspace, input.worktreeBaseRef),
        path: undefined,
        cleanupReason: undefined,
        status: "not_created"
      };
      task.pullRequestUrl = undefined;
      task.pullRequest = undefined;
    }

    task.description = input.description?.trim() ?? task.description;
    const nextColumn = input.column ?? task.column;
    const columnChanged = nextColumn !== task.column;
    task.column = nextColumn;
    task.order =
      input.order ??
      (columnChanged ? this.nextOrder(nextColumn) : task.order);
    task.runnerType = input.runnerType ?? task.runnerType;
    task.runnerConfig = input.runnerConfig ?? task.runnerConfig;

    if (
      nextWorkspace.isGitRepo &&
      (nextColumn === "done" || nextColumn === "archived") &&
      (task.worktree.status === "ready" || task.worktree.status === "cleanup_pending")
    ) {
      task.worktree = await this.gitWorktrees.cleanupTaskWorktree(nextWorkspace, task);
    }

    task.updatedAt = new Date().toISOString();

    this.store.setTasks(tasks);
    await this.store.save();
    if (
      previousColumn !== nextColumn &&
      (nextColumn === "done" || nextColumn === "archived")
    ) {
      await this.archiveTaskCodexThread(task);
    }
    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: task.id,
      task
    });
    if (
      previousColumn !== nextColumn &&
      (nextColumn === "todo" || nextColumn === "done")
    ) {
      await this.scheduler.evaluate();
    }
    return task;
  }

  public async deleteTask(taskId: string): Promise<DeleteResult> {
    if (this.runLifecycle.isActive(taskId)) {
      throw new AppError(
        409,
        "TASK_RUNNING",
        "Stop the active run before deleting the task"
      );
    }

    const task = this.requireTask(taskId);
    if (task.worktree.status === "ready" || task.worktree.status === "cleanup_pending") {
      throw new AppError(
        409,
        "TASK_WORKTREE_ACTIVE",
        "Cleanup the task worktree before deleting the task"
      );
    }

    const nextTasks = this.store.listTasks().filter((task) => task.id !== taskId);
    if (nextTasks.length === this.store.listTasks().length) {
      throw new AppError(404, "TASK_NOT_FOUND", "Task not found");
    }

    const nextRuns = this.store.listRuns().filter((run) => run.taskId !== taskId);
    this.store.setTasks(nextTasks);
    this.store.setRuns(nextRuns);
    await this.store.save();
    this.events.publish({
      type: "task.updated",
      action: "deleted",
      taskId
    });
    return { id: taskId };
  }

  public async startTask(
    taskId: string,
    input: StartTaskBody = {}
  ): Promise<{ task: Task; run: Run }> {
    return this.startTaskInternal(taskId, {
      targetOrder: input.order
    });
  }

  public async setTaskDependencies(
    taskId: string,
    dependencies: string[]
  ): Promise<Task> {
    const allTasks = this.store.listTasks();
    const task = this.requireTask(taskId, allTasks);

    // Validate all dependency IDs exist and are in the same workspace
    for (const depId of dependencies) {
      if (depId === taskId) {
        throw new AppError(400, "SELF_DEPENDENCY", "A task cannot depend on itself");
      }
      const dep = allTasks.find((t) => t.id === depId);
      if (!dep) {
        throw new AppError(
          404,
          "DEPENDENCY_NOT_FOUND",
          `Dependency task not found: ${depId}`
        );
      }
      if (dep.workspaceId !== task.workspaceId) {
        throw new AppError(
          409,
          "DEPENDENCY_CROSS_WORKSPACE",
          `Dependency task ${depId} belongs to a different workspace`
        );
      }
    }

    // Build hypothetical graph with new deps to check for cycles
    const hypotheticalTasks = allTasks.map((t) =>
      t.id === taskId ? { ...t, dependencies } : t
    );
    const graph = DependencyGraph.fromTasks(hypotheticalTasks);
    const cycle = graph.detectCycle();
    if (cycle !== null) {
      throw new AppError(
        422,
        "DEPENDENCY_CYCLE",
        `Circular dependency detected: ${cycle.join(" → ")}`
      );
    }

    const updatedTask = await this.store.updateTask(
      taskId,
      (t) => ({ ...t, dependencies, updatedAt: new Date().toISOString() })
    );
    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: updatedTask.id,
      task: updatedTask
    });
    return updatedTask;
  }

  public getSchedulerStatus(): { running: number; queued: number; blocked: number } {
    const counts = { running: 0, queued: 0, blocked: 0 };
    for (const t of this.store.listTasks()) {
      if (t.column === "running") counts.running++;
      else if (t.column === "todo") counts.queued++;
      else if (t.column === "blocked") counts.blocked++;
    }
    return counts;
  }

  public async evaluateScheduler(): Promise<{ started: string[]; blocked: string[] }> {
    const beforeTasks = this.store.listTasks();
    const beforeTodo = new Set(
      beforeTasks.filter((t) => t.column === "todo").map((t) => t.id)
    );
    const beforeBlocked = new Set(
      beforeTasks.filter((t) => t.column === "blocked").map((t) => t.id)
    );
    await this.scheduler.evaluate();
    const afterTasks = this.store.listTasks();
    const started = afterTasks
      .filter((t) => t.column === "running" && beforeTodo.has(t.id))
      .map((t) => t.id);
    const blocked = afterTasks
      .filter((t) => t.column === "blocked" && !beforeBlocked.has(t.id))
      .map((t) => t.id);
    return { started, blocked };
  }

  public async pollGitReviewTasksForBaseUpdates(): Promise<GitReviewMonitorResult> {
    return this.prMonitor.poll();
  }

  public async stopTask(taskId: string): Promise<{ task: Task; run: Run }> {
    return this.runLifecycle.stopRun(taskId);
  }

  public async sendTaskInput(
    taskId: string,
    input: TaskInputBody
  ): Promise<{ task: Task; run: Run }> {
    return this.runLifecycle.sendInput(taskId, input);
  }

  public async cleanupTaskWorktree(taskId: string): Promise<Task> {
    if (this.runLifecycle.isActive(taskId)) {
      throw new AppError(
        409,
        "TASK_RUNNING",
        "Stop the active run before cleaning up the task worktree"
      );
    }

    const tasks = this.store.listTasks();
    const task = this.requireTask(taskId, tasks);
    const workspace = this.requireWorkspace(task.workspaceId);

    task.worktree = await this.gitWorktrees.cleanupTaskWorktree(workspace, task);
    task.updatedAt = new Date().toISOString();

    this.store.setTasks(tasks);
    await this.store.save();
    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: task.id,
      task
    });

    return task;
  }

  public async planTask(taskId: string): Promise<{ task: Task; run: Run }> {
    const task = this.requireTask(taskId);

    if (task.column !== "backlog" && task.column !== "todo") {
      throw new AppError(
        409,
        "TASK_NOT_PLANNABLE",
        "Only backlog or todo tasks can generate a plan"
      );
    }

    const workspace = this.requireWorkspace(task.workspaceId);
    const planPrompt = this.buildPlanPrompt(task, workspace);

    return this.runLifecycle.startTask(taskId, {
      allowedColumns: ["backlog", "todo"],
      runnerConfigOverride: {
        type: "claude",
        prompt: planPrompt,
        permissionMode: "plan"
      },
      runMetadata: { trigger: "plan_generation" },
      targetColumn: "backlog",
      skipDependencyCheck: true
    });
  }

  public async sendPlanFeedback(
    taskId: string,
    input: { text: string }
  ): Promise<{ task: Task; run: Run }> {
    const text = input.text.trim();
    if (!text) {
      throw new AppError(400, "INVALID_PLAN_FEEDBACK", "Plan feedback cannot be blank");
    }

    const task = this.requireTask(taskId);
    if (task.column !== "backlog" && task.column !== "todo") {
      throw new AppError(
        409,
        "TASK_NOT_PLANNABLE",
        "Only backlog or todo tasks can receive plan feedback"
      );
    }

    const sessionId = this.findPlanSessionId(taskId);
    if (!sessionId) {
      throw new AppError(
        400,
        "NO_PLAN_SESSION",
        "No previous plan session found to resume"
      );
    }

    return this.runLifecycle.startTask(taskId, {
      allowedColumns: ["backlog", "todo"],
      runnerConfigOverride: {
        type: "claude",
        prompt: text,
        permissionMode: "plan"
      },
      runMetadata: {
        trigger: "plan_generation",
        resumeSessionId: sessionId
      },
      targetColumn: "backlog",
      skipDependencyCheck: true
    });
  }

  private findPlanSessionId(taskId: string): string | undefined {
    const runs = this.store
      .listRuns()
      .filter(
        (run) =>
          run.taskId === taskId && run.metadata?.trigger === "plan_generation"
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return runs[0]?.metadata?.claudeSessionId;
  }

  public async requestTaskReview(taskId: string): Promise<{ task: Task; run: Run }> {
    if (this.runLifecycle.isActive(taskId)) {
      throw new AppError(409, "TASK_ALREADY_RUNNING", "Task already has an active run");
    }

    const task = this.requireTask(taskId);
    if (task.column !== "review") {
      throw new AppError(
        409,
        "TASK_NOT_REVIEWABLE",
        "Only tasks in review can request a reviewer run"
      );
    }

    const workspace = this.requireWorkspace(task.workspaceId);
    if (!workspace.isGitRepo) {
      throw new AppError(
        400,
        "TASK_REVIEW_NOT_SUPPORTED",
        "Claude review is only available for Git-backed tasks"
      );
    }

    const refreshedTask = await this.refreshTaskPullRequestSnapshotForReview(task, workspace);
    return this.runLifecycle.startTask(refreshedTask.id, {
      allowedColumns: ["review"],
      runnerConfigOverride: this.aiReview.buildManualReviewRunnerConfig(
        refreshedTask,
        workspace
      ),
      runMetadata: this.aiReview.buildManualReviewRunMetadata(refreshedTask),
      skipDependencyCheck: true
    });
  }

  public async getTaskDiff(
    taskId: string
  ): Promise<{ files: DiffFile[]; baseRef: string; headRef: string }> {
    const task = this.requireTask(taskId);
    const workspace = this.requireWorkspace(task.workspaceId);

    if (!workspace.isGitRepo || !task.worktree.path || task.worktree.status === "removed") {
      throw new AppError(400, "DIFF_NOT_AVAILABLE", "Worktree is not available for diffing");
    }

    try {
      const raw = await this.gitWorktrees.getWorktreeDiff(
        task.worktree.path,
        task.worktree.baseRef
      );
      return {
        files: parseUnifiedDiff(raw),
        baseRef: task.worktree.baseRef,
        headRef: task.worktree.branchName
      };
    } catch (error) {
      throw new AppError(
        500,
        "DIFF_FAILED",
        `Failed to compute diff: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public listRuns(taskId: string): Run[] {
    this.requireTask(taskId);

    return this.store
      .listRuns()
      .filter((run) => run.taskId === taskId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  public async getRunLog(runId: string) {
    const run = this.requireRun(runId);

    return this.store.readLogEntries(runId);
  }

  private async archiveTaskCodexThread(task: Task): Promise<void> {
    return this.runLifecycle.archiveTaskCodexThread(task);
  }


  private async syncTaskPullRequestSnapshot(
    taskId: string,
    next: {
      pullRequestUrl?: string | null;
      pullRequest?: TaskPullRequest | null;
    }
  ): Promise<void> {
    const tasks = this.store.listTasks();
    const task = tasks.find((entry) => entry.id === taskId);
    if (!task) {
      return;
    }

    const nextPullRequestUrl =
      next.pullRequestUrl === undefined
        ? task.pullRequestUrl
        : next.pullRequestUrl?.trim() || undefined;
    const nextPullRequest =
      next.pullRequest === undefined ? task.pullRequest : next.pullRequest ?? undefined;

    if (
      task.pullRequestUrl === nextPullRequestUrl &&
      taskPullRequestEquals(task.pullRequest, nextPullRequest)
    ) {
      return;
    }

    task.pullRequestUrl = nextPullRequestUrl;
    task.pullRequest = nextPullRequest;
    task.updatedAt = new Date().toISOString();

    this.store.setTasks(tasks);
    await this.store.save();
    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: task.id,
      task
    });
  }

  private async refreshTaskPullRequestSnapshotForReview(
    task: Task,
    workspace: Workspace
  ): Promise<Task> {
    if (!(await this.githubPullRequests.isAvailable())) {
      return task;
    }

    const repositoryFullName =
      await this.gitWorktrees.getGitHubRepositoryFullName(workspace);
    if (!repositoryFullName) {
      return task;
    }

    try {
      const openPr = await this.githubPullRequests.findOpenPullRequest(
        repositoryFullName,
        task.worktree.branchName
      );
      if (!openPr) {
        return (
          this.store.listTasks().find((entry) => entry.id === task.id) ?? task
        );
      }

      const checks = await this.githubPullRequests.listRequiredChecks(
        repositoryFullName,
        openPr.number
      );
      await this.syncTaskPullRequestSnapshot(task.id, {
        pullRequestUrl: openPr.url,
        pullRequest: buildTaskPullRequestSummary(openPr, checks)
      });
    } catch {
      return this.store.listTasks().find((entry) => entry.id === task.id) ?? task;
    }

    return this.store.listTasks().find((entry) => entry.id === task.id) ?? task;
  }


  private async resetTaskWorktree(
    task: Task,
    workspace: Workspace,
    requestedBaseRef?: string
  ): Promise<TaskWorktree> {
    if (!workspace.isGitRepo) {
      return createTaskWorktree(task.id, task.title, {
        workspace,
        branchName: task.worktree.branchName,
        status: "removed"
      });
    }

    return createTaskWorktree(task.id, task.title, {
      workspace,
      baseRef: await this.gitWorktrees.resolveBaseRef(workspace, requestedBaseRef),
      branchName: task.worktree.branchName,
      status: "not_created"
    });
  }


  private async ensureReadableDirectory(path: string): Promise<void> {
    try {
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw new AppError(400, "INVALID_WORKSPACE", "Workspace path must be a directory");
      }

      await access(path, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(400, "INVALID_WORKSPACE", "Workspace path is not readable");
    }
  }

  private async detectGitRepo(path: string): Promise<boolean> {
    try {
      await access(join(path, ".git"), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private ensureRunnerConfig(
    runnerType: Task["runnerType"],
    runnerConfig: RunnerConfig
  ): void {
    if (runnerConfig.type !== runnerType) {
      throw new AppError(
        400,
        "RUNNER_CONFIG_MISMATCH",
        "runnerType and runnerConfig.type must match"
      );
    }

    if (runnerType === "shell" && runnerConfig.type === "shell") {
      if (!runnerConfig.command.trim()) {
        throw new AppError(400, "INVALID_RUNNER_CONFIG", "Shell command is required");
      }
      return;
    }

    if (runnerType === "claude" && runnerConfig.type === "claude") {
      if (!runnerConfig.prompt.trim()) {
        throw new AppError(400, "INVALID_RUNNER_CONFIG", "Claude prompt is required");
      }
      return;
    }

    if (runnerType === "codex" && runnerConfig.type === "codex") {
      if (!runnerConfig.prompt.trim()) {
        throw new AppError(400, "INVALID_RUNNER_CONFIG", "Codex prompt is required");
      }
      return;
    }

    throw new AppError(400, "INVALID_RUNNER_CONFIG", "Unsupported runner configuration");
  }

  private buildPlanPrompt(task: Task, workspace: Workspace): string {
    return resolveTemplate(
      resolveWorkspacePromptTemplate("plan", workspace.promptTemplates),
      {
        taskTitle: task.title,
        taskDescription: task.description.trim(),
        taskDescriptionBlock: task.description.trim()
          ? `Task description:\n${task.description.trim()}`
          : "",
        workingDirectory: workspace.rootPath,
        baseRef: task.worktree.baseRef,
        branchName: task.worktree.branchName
      }
    );
  }

  // -------------------------------------------------------------------------
  // Agent Teams
  // -------------------------------------------------------------------------

  public listTeams(workspaceId?: string): AgentTeam[] {
    return this.store.listTeams(workspaceId);
  }

  public getTeam(teamId: string): AgentTeam {
    const team = this.store.getTeam(teamId);
    if (!team) {
      throw new AppError(404, "TEAM_NOT_FOUND", "Team not found");
    }
    return team;
  }

  public createTeam(input: CreateTeamBody): AgentTeam {
    this.requireWorkspace(input.workspaceId);
    validateTeamAgents(input.agents);
    const now = new Date().toISOString();
    const team: AgentTeam = {
      id: createId(),
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      workspaceId: input.workspaceId,
      agents: input.agents,
      prStrategy: input.prStrategy ?? "independent",
      autoApproveSubtasks: input.autoApproveSubtasks ?? false,
      createdAt: now,
      updatedAt: now
    };
    this.store.createTeam(team);
    this.events.publish({ type: "team.updated", action: "created", teamId: team.id, team });
    return team;
  }

  public updateTeam(teamId: string, input: UpdateTeamBody): AgentTeam {
    const updates: Partial<
      Pick<AgentTeam, "name" | "description" | "agents" | "prStrategy" | "autoApproveSubtasks">
    > = {};
    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.description !== undefined) updates.description = input.description.trim();
    if (input.agents !== undefined) {
      validateTeamAgents(input.agents);
      updates.agents = input.agents;
    }
    if (input.prStrategy !== undefined) updates.prStrategy = input.prStrategy;
    if (input.autoApproveSubtasks !== undefined) {
      updates.autoApproveSubtasks = input.autoApproveSubtasks;
    }

    const updated = this.store.updateTeam(teamId, updates);
    if (!updated) {
      throw new AppError(404, "TEAM_NOT_FOUND", "Team not found");
    }
    this.events.publish({ type: "team.updated", action: "updated", teamId: updated.id, team: updated });
    return updated;
  }

  public deleteTeam(teamId: string): DeleteResult {
    const deleted = this.store.deleteTeam(teamId);
    if (!deleted) {
      throw new AppError(404, "TEAM_NOT_FOUND", "Team not found");
    }
    this.events.publish({ type: "team.updated", action: "deleted", teamId });
    return { id: teamId };
  }

  public listTeamMessages(teamId: string, parentTaskId?: string): TeamMessage[] {
    // Ensure team exists before listing messages
    this.getTeam(teamId);
    return this.store.listTeamMessages(teamId, parentTaskId);
  }

  public postHumanTeamMessage(
    teamId: string,
    parentTaskId: string,
    content: string
  ): TeamMessage {
    const team = this.getTeam(teamId);
    const parentTask = this.requireTask(parentTaskId);
    if (parentTask.teamId !== team.id || parentTask.parentTaskId) {
      throw new AppError(
        400,
        "INVALID_PARENT_TASK",
        "parentTaskId must reference a parent task in the selected team"
      );
    }

    const trimmedContent = content.trim();
    if (!trimmedContent) {
      throw new AppError(
        400,
        "INVALID_TEAM_MESSAGE",
        "Team message content cannot be blank"
      );
    }
    const finalContent = truncateTeamMessagePayload(trimmedContent);

    const item: TeamMessage = {
      id: createId(),
      teamId: team.id,
      parentTaskId: parentTask.id,
      // Human feedback is stored on the shared parent thread, even when authored
      // from a subtask details panel that is rendering the same conversation.
      taskId: parentTask.id,
      agentName: "User",
      senderType: "human",
      messageType: "feedback",
      content: finalContent,
      createdAt: new Date().toISOString()
    };

    this.store.appendTeamMessage(item);
    this.events.publish(
      buildTeamAgentMessageEvent({
        teamId: team.id,
        parentTaskId: parentTask.id,
        fromAgentId: "human",
        messageType: "feedback",
        payload: finalContent
      })
    );
    return item;
  }

  public async approveTask(taskId: string): Promise<Task> {
    const { task, team, parentTask } = this.requireReviewableTeamSubtask(taskId);
    const effectiveLastRunStatus = this.resolveEffectiveLastRunStatus(task);
    if (effectiveLastRunStatus !== "succeeded") {
      throw new AppError(
        409,
        "TASK_APPROVAL_NOT_ALLOWED",
        "Only succeeded subtasks can be approved"
      );
    }

    const approvedTask = await this.store.updateState((state) => {
      const taskIndex = state.tasks.findIndex((entry) => entry.id === task.id);
      if (taskIndex === -1) {
        return null;
      }

      const currentTask = state.tasks[taskIndex]!;
      if (currentTask.column !== "review") {
        return null;
      }

      currentTask.column = "done";
      currentTask.rejected = false;
      currentTask.order = this.nextOrderFromTasks("done", state.tasks);
      currentTask.updatedAt = new Date().toISOString();
      return { ...currentTask };
    });

    if (!approvedTask) {
      throw new AppError(409, "TASK_NOT_REVIEWABLE", "Only review subtasks can be approved");
    }

    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: approvedTask.id,
      task: approvedTask
    });
    // Approve is the explicit human decision that a succeeded review result
    // should count as complete work for parent aggregation.
    this.publishTeamThreadMessage({
      ...(team ? { teamId: team.id } : { workspaceId: task.workspaceId }),
      parentTaskId: parentTask.id,
      taskId: approvedTask.id,
      agentName: "User",
      fromAgentId: "human",
      senderType: "human",
      messageType: "status",
      payload: truncateTeamMessagePayload(`User approved subtask "${approvedTask.title}".`)
    });
    await this.checkAndHandleTeamCompletion(parentTask.id, team?.id ?? null);
    return approvedTask;
  }

  public async rejectTask(taskId: string, reason?: string): Promise<Task> {
    const { task, team, parentTask } = this.requireReviewableTeamSubtask(taskId);
    const trimmedReason = reason?.trim();

    const rejectedTask = await this.store.updateState((state) => {
      const taskIndex = state.tasks.findIndex((entry) => entry.id === task.id);
      if (taskIndex === -1) {
        return null;
      }

      const currentTask = state.tasks[taskIndex]!;
      if (currentTask.column !== "review") {
        return null;
      }

      currentTask.column = "done";
      currentTask.rejected = true;
      currentTask.order = this.nextOrderFromTasks("done", state.tasks);
      currentTask.updatedAt = new Date().toISOString();
      return { ...currentTask };
    });

    if (!rejectedTask) {
      throw new AppError(409, "TASK_NOT_REVIEWABLE", "Only review subtasks can be rejected");
    }

    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: rejectedTask.id,
      task: rejectedTask
    });
    this.publishTeamThreadMessage({
      ...(team ? { teamId: team.id } : { workspaceId: task.workspaceId }),
      parentTaskId: parentTask.id,
      taskId: rejectedTask.id,
      agentName: "User",
      fromAgentId: "human",
      senderType: "human",
      messageType: "status",
      payload: truncateTeamMessagePayload(
        trimmedReason
          ? `User rejected subtask "${rejectedTask.title}". Reason: ${trimmedReason}`
          : `User rejected subtask "${rejectedTask.title}".`
      )
    });
    await this.checkAndHandleTeamCompletion(parentTask.id, team?.id ?? null);
    return rejectedTask;
  }

  public async retryTask(taskId: string): Promise<Task> {
    const { task, team, parentTask } = this.requireReviewableTeamSubtask(taskId);

    const queuedTask = await this.store.updateState((state) => {
      const taskIndex = state.tasks.findIndex((entry) => entry.id === task.id);
      if (taskIndex === -1) {
        return null;
      }

      const currentTask = state.tasks[taskIndex]!;
      if (currentTask.column !== "review") {
        return null;
      }

      currentTask.column = "todo";
      currentTask.rejected = false;
      currentTask.lastRunStatus = undefined;
      currentTask.order = this.topOrderFromTasks("todo", state.tasks, currentTask.id);
      currentTask.updatedAt = new Date().toISOString();
      return { ...currentTask };
    });

    if (!queuedTask) {
      throw new AppError(409, "TASK_NOT_REVIEWABLE", "Only review subtasks can be retried");
    }

    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: queuedTask.id,
      task: queuedTask
    });
    this.publishTeamThreadMessage({
      ...(team ? { teamId: team.id } : { workspaceId: task.workspaceId }),
      parentTaskId: parentTask.id,
      taskId: queuedTask.id,
      agentName: "User",
      fromAgentId: "human",
      senderType: "human",
      messageType: "status",
      // Retry intentionally clears the previous terminal decision so the next
      // run becomes the source of truth for approval / rejection.
      payload: truncateTeamMessagePayload(`User requested retry for subtask "${queuedTask.title}".`)
    });

    await this.evaluateScheduler();
    return this.requireTask(taskId);
  }

  public async cancelSubtask(teamId: string | null, taskId: string): Promise<Task> {
    const { task, team, parentTask } = this.requireTeamSubtask(taskId, teamId ?? undefined);

    const cancellation = await this.store.updateState((state) => {
      const taskIndex = state.tasks.findIndex((entry) => entry.id === task.id);
      if (taskIndex === -1) {
        return null;
      }

      const currentTask = state.tasks[taskIndex]!;
      if (currentTask.column === "done" || currentTask.column === "archived") {
        return null;
      }

      const shouldStopRun = currentTask.column === "running";
      currentTask.column = "done";
      currentTask.cancelledAt = new Date().toISOString();
      currentTask.rejected = false;
      currentTask.order = this.nextOrderFromTasks("done", state.tasks);
      currentTask.updatedAt = new Date().toISOString();

      return {
        task: { ...currentTask },
        shouldStopRun
      };
    });

    if (!cancellation) {
      throw new AppError(
        409,
        "TASK_CANCEL_NOT_ALLOWED",
        "Only active team subtasks can be cancelled"
      );
    }

    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: cancellation.task.id,
      task: cancellation.task
    });
    this.publishTeamThreadMessage({
      ...(team ? { teamId: team.id } : { workspaceId: task.workspaceId }),
      parentTaskId: parentTask.id,
      taskId: cancellation.task.id,
      agentName: "User",
      fromAgentId: "human",
      senderType: "human",
      messageType: "status",
      payload: truncateTeamMessagePayload(`User cancelled subtask "${cancellation.task.title}".`)
    });

    await this.checkAndHandleTeamCompletion(parentTask.id, team?.id ?? null);

    if (cancellation.shouldStopRun) {
      void this.runLifecycle.stopRun(taskId).catch(() => {
        // Best-effort stop: the subtask is already marked cancelled in state.
      });
    }

    return cancellation.task;
  }

  private requireTeamSubtask(
    taskId: string,
    teamId?: string
  ): {
    task: Task;
    team: AgentTeam | null;
    parentTask: Task;
  } {
    const task = this.requireTask(taskId);
    if (!task.parentTaskId) {
      throw new AppError(409, "TASK_NOT_TEAM_SUBTASK", "Task is not a team subtask");
    }

    if (task.teamId) {
      if (teamId && task.teamId !== teamId) {
        throw new AppError(
          409,
          "INVALID_TEAM_TASK",
          "Task does not belong to the selected team"
        );
      }
      const team = this.getTeam(task.teamId);
      const parentTask = this.requireTask(task.parentTaskId);
      if (parentTask.teamId !== team.id || parentTask.parentTaskId) {
        throw new AppError(
          409,
          "INVALID_PARENT_TASK",
          "parentTaskId must reference a parent task owned by the same team"
        );
      }
      return { task, team, parentTask };
    }

    // Workspace-agent subtask (no teamId)
    const parentTask = this.requireTask(task.parentTaskId);
    if (parentTask.parentTaskId) {
      throw new AppError(
        409,
        "INVALID_PARENT_TASK",
        "parentTaskId must reference a parent coordinator task"
      );
    }
    return { task, team: null, parentTask };
  }

  private requireReviewableTeamSubtask(taskId: string): {
    task: Task;
    team: AgentTeam | null;
    parentTask: Task;
  } {
    const { task, team, parentTask } = this.requireTeamSubtask(taskId);
    if (task.column !== "review") {
      throw new AppError(409, "TASK_NOT_REVIEWABLE", "Only review subtasks can be changed");
    }

    return { task, team, parentTask };
  }

  private resolveEffectiveLastRunStatus(task: Task): Run["status"] | undefined {
    if (task.lastRunStatus) {
      return task.lastRunStatus;
    }
    if (!task.lastRunId) {
      return undefined;
    }
    return this.store.listRuns().find((run) => run.id === task.lastRunId)?.status;
  }

  // -------------------------------------------------------------------------
  // Coordinator Proposals
  // -------------------------------------------------------------------------

  public listProposals(teamId: string, query: ListProposalsQuery): CoordinatorProposal[] {
    this.getTeam(teamId);
    return this.store.listProposals(teamId, query.parentTaskId);
  }

  public getProposal(teamId: string, proposalId: string): CoordinatorProposal {
    this.getTeam(teamId);
    const proposal = this.store.getProposal(proposalId);
    if (!proposal || proposal.teamId !== teamId) {
      throw new AppError(404, "PROPOSAL_NOT_FOUND", "Coordinator proposal not found");
    }
    return proposal;
  }

  public async approveProposal(teamId: string, proposalId: string): Promise<void> {
    const proposal = this.getProposal(teamId, proposalId);

    // C2: atomically claim the proposal before any async work to prevent
    // concurrent approve calls from creating duplicate subtasks.
    const now = new Date().toISOString();
    const claimed = this.store.updateProposalStatusCAS(proposalId, "pending", "approved", now);
    if (!claimed) {
      throw new AppError(409, "PROPOSAL_ALREADY_DECIDED", "Proposal has already been approved or rejected");
    }

    // W3: use requireTask instead of a linear scan
    const parentTask = this.requireTask(proposal.parentTaskId);

    const team = this.getTeam(teamId);
    let updatedParent: Task;
    let subtasks: Task[];
    try {
      ({ parentTask: updatedParent, subtasks } = await this.createCoordinatorSubtasks(
        parentTask,
        team,
        proposal.drafts
      ));
    } catch (error) {
      // Roll back the CAS so the proposal can be re-approved after the error is resolved.
      this.store.updateProposalStatus(proposalId, "pending", null);
      throw error;
    }

    // Publish a coordinator context summary message to the team feed
    const coordinator = this.resolveCoordinatorAgent(team);
    const messageEvent = buildTeamAgentMessageEvent({
      teamId: team.id,
      parentTaskId: parentTask.id,
      fromAgentId: coordinator.id,
      messageType: "context",
      payload: this.buildCoordinatorSummary(
        subtasks,
        (subtask) => this.resolveAssignedTeamAgent(team, subtask).agentName
      )
    });
    this.store.appendTeamMessage({
      id: createId(),
      teamId: team.id,
      parentTaskId: parentTask.id,
      taskId: parentTask.id,
      agentName: coordinator.agentName,
      senderType: "agent",
      messageType: messageEvent.messageType,
      content: messageEvent.payload,
      createdAt: new Date().toISOString()
    });

    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: updatedParent.id,
      task: updatedParent
    });
    for (const subtask of subtasks) {
      this.events.publish({
        type: "task.updated",
        action: "created",
        taskId: subtask.id,
        task: subtask
      });
    }
    this.events.publish(messageEvent);
    this.events.publish(
      buildTeamTaskCreatedEvent({
        teamId: team.id,
        parentTaskId: parentTask.id,
        subtasks: subtasks.map((subtask) => ({
          taskId: subtask.id,
          title: subtask.title,
          agentName: this.resolveAssignedTeamAgent(team, subtask).agentName
        }))
      })
    );
    // W1: notify the UI that the proposal status has changed
    this.events.publish({
      type: "team.proposal.updated",
      teamId: team.id,
      parentTaskId: parentTask.id,
      proposal: claimed
    });

    await this.scheduler.evaluate();
  }

  public rejectProposal(teamId: string, proposalId: string): void {
    const proposal = this.getProposal(teamId, proposalId);
    if (proposal.status !== "pending") {
      throw new AppError(409, "PROPOSAL_ALREADY_DECIDED", "Proposal has already been approved or rejected");
    }
    const now = new Date().toISOString();
    const updated = this.store.updateProposalStatus(proposalId, "rejected", now);
    // W1: notify the UI that the proposal status has changed
    if (updated) {
      this.events.publish({
        type: "team.proposal.updated",
        teamId: teamId,
        parentTaskId: proposal.parentTaskId,
        proposal: updated
      });
    }
    // Parent task remains in "review" so the user can re-run the coordinator.
  }

  // -------------------------------------------------------------------------
  // Workspace-scoped Coordinator Proposals (Phase 4)
  // -------------------------------------------------------------------------

  public listProposalsByWorkspace(
    workspaceId: string,
    query: { parentTaskId?: string }
  ): CoordinatorProposal[] {
    this.requireWorkspace(workspaceId);
    return this.store.listProposalsByWorkspace(workspaceId, query.parentTaskId);
  }

  public getProposalByWorkspace(
    workspaceId: string,
    proposalId: string
  ): CoordinatorProposal {
    this.requireWorkspace(workspaceId);
    const proposal = this.store.getProposal(proposalId);
    if (!proposal || proposal.workspaceId !== workspaceId) {
      throw new AppError(404, "PROPOSAL_NOT_FOUND", "Coordinator proposal not found");
    }
    return proposal;
  }

  public async approveProposalByWorkspace(
    workspaceId: string,
    proposalId: string
  ): Promise<void> {
    const proposal = this.getProposalByWorkspace(workspaceId, proposalId);

    const now = new Date().toISOString();
    const claimed = this.store.updateProposalStatusCAS(proposalId, "pending", "approved", now);
    if (!claimed) {
      throw new AppError(409, "PROPOSAL_ALREADY_DECIDED", "Proposal has already been approved or rejected");
    }

    const parentTask = this.requireTask(proposal.parentTaskId);
    const workspace = this.requireWorkspace(workspaceId);
    const agents = this.store.listWorkspaceAgents(workspaceId);

    let updatedParent: Task;
    let subtasks: Task[];
    try {
      ({ parentTask: updatedParent, subtasks } = await this.createCoordinatorSubtasksWs(
        parentTask,
        agents,
        workspace,
        proposal.drafts
      ));
    } catch (error) {
      this.store.updateProposalStatus(proposalId, "pending", null);
      throw error;
    }

    const coordinator = this.resolveCoordinator(agents);
    const summaryPayload = this.buildCoordinatorSummary(
      subtasks,
      (subtask) => this.resolveAssignedAgent(agents, subtask).name
    );
    // HACK: reuse teamId field for workspaceId until PR-D event rename
    const messageEvent = buildTeamAgentMessageEvent({
      teamId: workspaceId,
      parentTaskId: parentTask.id,
      fromAgentId: coordinator.id,
      messageType: "context",
      payload: summaryPayload
    });
    this.store.appendTaskMessage({
      id: createId(),
      parentTaskId: parentTask.id,
      taskId: parentTask.id,
      agentName: coordinator.name,
      senderType: "agent",
      messageType: messageEvent.messageType,
      content: messageEvent.payload,
      createdAt: new Date().toISOString()
    });

    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: updatedParent.id,
      task: updatedParent
    });
    for (const subtask of subtasks) {
      this.events.publish({
        type: "task.updated",
        action: "created",
        taskId: subtask.id,
        task: subtask
      });
    }
    this.events.publish(messageEvent);
    // HACK: reuse teamId field for workspaceId until PR-D event rename
    this.events.publish(
      buildTeamTaskCreatedEvent({
        teamId: workspaceId,
        parentTaskId: parentTask.id,
        subtasks: subtasks.map((subtask) => ({
          taskId: subtask.id,
          title: subtask.title,
          agentName: this.resolveAssignedAgent(agents, subtask).name
        }))
      })
    );
    // HACK: reuse teamId field for workspaceId until PR-D event rename
    this.events.publish({
      type: "team.proposal.updated",
      teamId: workspaceId,
      parentTaskId: parentTask.id,
      proposal: claimed
    });

    await this.scheduler.evaluate();
  }

  public rejectProposalByWorkspace(workspaceId: string, proposalId: string): void {
    const proposal = this.getProposalByWorkspace(workspaceId, proposalId);
    if (proposal.status !== "pending") {
      throw new AppError(409, "PROPOSAL_ALREADY_DECIDED", "Proposal has already been approved or rejected");
    }
    const now = new Date().toISOString();
    const updated = this.store.updateProposalStatus(proposalId, "rejected", now);
    if (updated) {
      // HACK: reuse teamId field for workspaceId until PR-D event rename
      this.events.publish({
        type: "team.proposal.updated",
        teamId: workspaceId,
        parentTaskId: proposal.parentTaskId,
        proposal: updated
      });
    }
  }

  private nextOrder(column: Task["column"]): number {
    const columnTasks = this.store
      .listTasks()
      .filter((task) => task.column === column)
      .sort((left, right) => left.order - right.order);

    const last = columnTasks.at(-1);
    return last ? last.order + 1_024 : 1_024;
  }

  private topOrder(column: Task["column"], excludingTaskId?: string): number {
    const columnTasks = this.store
      .listTasks()
      .filter((task) => task.column === column && task.id !== excludingTaskId)
      .sort((left, right) => left.order - right.order);

    const first = columnTasks[0];
    return first ? first.order - 1_024 : 1_024;
  }

  // -------------------------------------------------------------------------
  // Agent CRUD (Phase 4)
  // -------------------------------------------------------------------------

  public listAgents(): AccountAgent[] {
    return this.store.listAgents();
  }

  public createAgent(body: CreateAgentBody): AccountAgent {
    const now = new Date().toISOString();
    const agent: AccountAgent = {
      id: createId(),
      name: body.name,
      description: body.description,
      runnerConfig: body.runnerConfig,
      createdAt: now,
      updatedAt: now
    };
    return this.store.createAgent(agent);
  }

  public getAgent(agentId: string): AccountAgent {
    const agent = this.store.getAgent(agentId);
    if (!agent) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    }
    return agent;
  }

  public updateAgent(agentId: string, body: UpdateAgentBody): AccountAgent {
    const updated = this.store.updateAgent(agentId, body);
    if (!updated) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    }
    return updated;
  }

  public deleteAgent(agentId: string): void {
    const deleted = this.store.deleteAgent(agentId);
    if (!deleted) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    }
  }

  // -------------------------------------------------------------------------
  // Workspace Agent management (Phase 4)
  // -------------------------------------------------------------------------

  public listWorkspaceAgentsByWorkspace(workspaceId: string): WorkspaceAgent[] {
    this.requireWorkspace(workspaceId);
    return this.store.listWorkspaceAgents(workspaceId);
  }

  public mountAgent(workspaceId: string, body: MountAgentBody): WorkspaceAgent {
    this.requireWorkspace(workspaceId);
    return this.store.mountAgentToWorkspace(workspaceId, body.agentId, body.role as AgentRole);
  }

  public unmountAgent(workspaceId: string, agentId: string): void {
    this.requireWorkspace(workspaceId);
    const removed = this.store.unmountAgentFromWorkspace(workspaceId, agentId);
    if (!removed) {
      throw new AppError(404, "WORKSPACE_AGENT_NOT_FOUND", `Agent ${agentId} not mounted in workspace ${workspaceId}`);
    }
  }

  public updateAgentRole(
    workspaceId: string,
    agentId: string,
    body: UpdateAgentRoleBody
  ): WorkspaceAgent {
    this.requireWorkspace(workspaceId);
    const updated = this.store.updateWorkspaceAgentRole(workspaceId, agentId, body.role as AgentRole);
    if (!updated) {
      throw new AppError(404, "WORKSPACE_AGENT_NOT_FOUND", `Agent ${agentId} not mounted in workspace ${workspaceId}`);
    }
    return updated;
  }

  // -------------------------------------------------------------------------
  // Workspace config (Phase 4)
  // -------------------------------------------------------------------------

  public updateWorkspaceConfig(workspaceId: string, body: UpdateWorkspaceConfigBody): Workspace {
    const updated = this.store.updateWorkspaceConfig(workspaceId, body);
    if (!updated) {
      throw new AppError(404, "WORKSPACE_NOT_FOUND", `Workspace not found: ${workspaceId}`);
    }
    return updated;
  }

  // -------------------------------------------------------------------------
  // Task Messages (Phase 4)
  // -------------------------------------------------------------------------

  public listTaskMessagesByWorkspace(workspaceId: string, parentTaskId?: string): TaskMessage[] {
    this.requireWorkspace(workspaceId);
    if (!parentTaskId) {
      throw new AppError(400, "PARENT_TASK_ID_REQUIRED", "parentTaskId query parameter is required");
    }
    return this.store.listTaskMessages(parentTaskId);
  }

  public postTaskMessage(workspaceId: string, body: PostTaskMessageBody): TaskMessage {
    this.requireWorkspace(workspaceId);
    const task = this.requireTask(body.parentTaskId);
    if (task.workspaceId !== workspaceId) {
      throw new AppError(403, "WORKSPACE_MISMATCH", "Task does not belong to this workspace");
    }
    const message: TaskMessage = {
      id: createId(),
      parentTaskId: body.parentTaskId,
      agentName: "human",
      senderType: "human",
      messageType: "context",
      content: body.content,
      createdAt: new Date().toISOString()
    };
    this.store.appendTaskMessage(message);
    return message;
  }

  // -------------------------------------------------------------------------
  // Workspace-scoped cancel subtask (Phase 4)
  // -------------------------------------------------------------------------

  public async cancelSubtaskByWorkspace(workspaceId: string, taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    if (!task.parentTaskId) {
      throw new AppError(409, "TASK_NOT_SUBTASK", "Task is not a subtask");
    }
    if (task.workspaceId !== workspaceId) {
      throw new AppError(403, "WORKSPACE_MISMATCH", "Task does not belong to this workspace");
    }
    return this.cancelSubtask(null, taskId);
  }

}
