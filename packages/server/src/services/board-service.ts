import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import type {
  AgentTeam,
  AppState,
  CreateTaskBody,
  CreateTeamBody,
  CreateWorkspaceBody,
  DeleteResult,
  GlobalSettings,
  HealthCodexQuotaData,
  ListTasksQuery,
  Run,
  RunnerConfig,
  StartTaskBody,
  TaskInputBody,
  Task,
  TaskPullRequest,
  TaskWorktree,
  TeamAgent,
  TeamMessage,
  UpdateSettingsBody,
  UpdateTaskBody,
  UpdateTeamBody,
  UpdateWorkspaceBody,
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

interface BoardServiceDependencies {
  gitWorktrees?: GitWorktreeService;
  githubPullRequests?: GitHubPullRequestProvider;
  codexAppServer?: CodexAppServer;
  taskIdentityGenerator?: TaskIdentityGenerator;
  workspaceRootPicker?: WorkspaceRootPicker;
  runners?: Record<string, RunnerAdapter>;
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
    if (!task.teamId) {
      return undefined;
    }

    const team = this.getTeam(task.teamId);
    if (task.parentTaskId) {
      return this.buildSubtaskStartOptions(task, team);
    }

    return this.buildCoordinatorStartOptions(task, team);
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
    if (!task.teamId) {
      return;
    }

    if (task.parentTaskId) {
      await this.handleSubtaskRunFinished(task, run);
      return;
    }

    if (run.status !== "succeeded" || run.metadata?.trigger !== "team_coordinator") {
      return;
    }

    try {
      const team = this.getTeam(task.teamId);
      const coordinator = this.resolveCoordinatorAgent(team);
      const output = await this.extractCoordinatorOutput(run.id);
      const drafts = parseCoordinatorSubtasks(output);
      const { parentTask, subtasks } = await this.createCoordinatorSubtasks(
        task,
        team,
        drafts
      );

      const messageEvent = buildTeamAgentMessageEvent({
        teamId: team.id,
        parentTaskId: task.id,
        fromAgentId: coordinator.id,
        messageType: "context",
        payload: this.buildCoordinatorSummary(subtasks, team)
      });
      this.store.appendTeamMessage({
        id: createId(),
        teamId: team.id,
        parentTaskId: task.id,
        taskId: task.id,
        agentName: coordinator.agentName,
        senderType: "agent",
        messageType: messageEvent.messageType,
        content: messageEvent.payload,
        createdAt: new Date().toISOString()
      });

      this.events.publish({
        type: "task.updated",
        action: "updated",
        taskId: parentTask.id,
        task: parentTask
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
          parentTaskId: task.id,
          subtasks: subtasks.map((subtask) => ({
            taskId: subtask.id,
            title: subtask.title,
            agentName: this.resolveAssignedTeamAgent(team, subtask).agentName
          }))
        })
      );

      await this.scheduler.evaluate();
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

    const team = this.getTeam(task.teamId!);
    const agent = this.resolveAssignedTeamAgent(team, task);
    const now = new Date().toISOString();

    // A-type: status message
    const statusPayload = buildSubtaskStatusPayload(task, run);
    this.store.appendTeamMessage({
      id: createId(),
      teamId: team.id,
      parentTaskId: task.parentTaskId!,
      taskId: task.id,
      agentName: agent.agentName,
      senderType: "agent",
      messageType: "status",
      content: statusPayload,
      createdAt: now
    });
    this.events.publish(
      buildTeamAgentMessageEvent({
        teamId: team.id,
        parentTaskId: task.parentTaskId!,
        fromAgentId: agent.id,
        messageType: "status",
        payload: statusPayload
      })
    );

    if (run.status === "succeeded") {
      // B-type: artifact message — generated before auto-advancing to "done" so that
      // the aggregation check (triggered by other subtasks) cannot fire before this
      // artifact message is persisted. Best-effort: skip on git errors.
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
        this.store.appendTeamMessage({
          id: createId(),
          teamId: team.id,
          parentTaskId: task.parentTaskId!,
          taskId: task.id,
          agentName: agent.agentName,
          senderType: "agent",
          messageType: "artifact",
          content: artifactPayload,
          createdAt: now
        });
        this.events.publish(
          buildTeamAgentMessageEvent({
            teamId: team.id,
            parentTaskId: task.parentTaskId!,
            fromAgentId: agent.id,
            messageType: "artifact",
            payload: artifactPayload
          })
        );
      } catch {
        // Best-effort: git diff not critical for team coordination
      }

      // Move succeeded subtask to "done" after artifact is persisted —
      // subtasks are owned by the coordinator and don't require a human review step.
      const doneTask = await this.store.updateState((state) => {
        const idx = state.tasks.findIndex((t) => t.id === task.id);
        if (idx === -1) {
          return null;
        }
        const entry = state.tasks[idx]!;
        if (entry.column !== "review") {
          return null;
        }
        entry.column = "done";
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

    await this.checkAndHandleTeamCompletion(task.parentTaskId!, team.id);
  }

  private async checkAndHandleTeamCompletion(
    parentTaskId: string,
    teamId: string
  ): Promise<void> {
    type AggregationResult =
      | { action: "all_done"; parent: Task; subtasks: Task[] }
      | { action: "some_failed"; parent: Task; failedSubtasks: Task[] };

    // Read subtask state and update the parent atomically in one updateState call
    // to prevent TOCTOU races when multiple subtasks complete concurrently.
    const result = await this.store.updateState(
      (state): AggregationResult | null => {
        const subtasks = state.tasks.filter(
          (t) => t.parentTaskId === parentTaskId && t.teamId === teamId
        );
        if (subtasks.length === 0) {
          return null;
        }

        // Subtasks in "done" = succeeded. Subtasks in "review" = failed (run failed, awaits human).
        // Subtasks in todo/blocked/running = still in progress.
        const stillInProgress = subtasks.some(
          (t) => t.column === "todo" || t.column === "blocked" || t.column === "running"
        );
        if (stillInProgress) {
          return null;
        }

        const parentIndex = state.tasks.findIndex((t) => t.id === parentTaskId);
        if (parentIndex === -1) {
          return null;
        }
        const parent = state.tasks[parentIndex]!;
        // Idempotence guard: only act if parent is still running
        if (parent.column !== "running") {
          return null;
        }

        const failedSubtasks = subtasks.filter((t) => t.column === "review");
        const now = new Date().toISOString();

        if (failedSubtasks.length > 0) {
          parent.column = "blocked";
          parent.order = this.topOrderFromTasks("blocked", state.tasks, parent.id);
          parent.updatedAt = now;
          return {
            action: "some_failed",
            parent: { ...parent },
            failedSubtasks: failedSubtasks.map((t) => ({ ...t }))
          };
        }

        parent.column = "review";
        parent.order = this.topOrderFromTasks("review", state.tasks, parent.id);
        parent.updatedAt = now;
        return {
          action: "all_done",
          parent: { ...parent },
          subtasks: subtasks.map((t) => ({ ...t }))
        };
      }
    );

    if (!result) {
      return;
    }

    const now = new Date().toISOString();

    if (result.action === "all_done") {
      const summaryLines = [
        "All subtasks completed successfully:",
        ...result.subtasks.map((t) => `- ${t.title}`)
      ];
      const payload = truncateTeamMessagePayload(summaryLines.join("\n"));
      this.store.appendTeamMessage({
        id: createId(),
        teamId,
        parentTaskId,
        taskId: parentTaskId,
        agentName: "system",
        senderType: "system",
        messageType: "status",
        content: payload,
        createdAt: now
      });
      this.events.publish({
        type: "task.updated",
        action: "updated",
        taskId: result.parent.id,
        task: result.parent
      });
      this.events.publish(
        buildTeamAgentMessageEvent({
          teamId,
          parentTaskId,
          fromAgentId: "system",
          messageType: "status",
          payload
        })
      );
    } else {
      const summaryLines = [
        "Team execution failed. The following subtasks did not complete:",
        ...result.failedSubtasks.map((t) => `- ${t.title}`)
      ];
      const payload = truncateTeamMessagePayload(summaryLines.join("\n"));
      this.store.appendTeamMessage({
        id: createId(),
        teamId,
        parentTaskId,
        taskId: parentTaskId,
        agentName: "system",
        senderType: "system",
        messageType: "status",
        content: payload,
        createdAt: now
      });
      this.events.publish({
        type: "task.updated",
        action: "updated",
        taskId: result.parent.id,
        task: result.parent
      });
      this.events.publish({
        type: "task.blocked",
        taskId: result.parent.id,
        blockedBy: result.failedSubtasks.map((t) => t.id)
      });
      this.events.publish(
        buildTeamAgentMessageEvent({
          teamId,
          parentTaskId,
          fromAgentId: "system",
          messageType: "status",
          payload
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

  private buildCoordinatorSummary(subtasks: Task[], team: AgentTeam): string {
    const lines = ["Coordinator created subtasks:"];
    for (const subtask of subtasks) {
      const agentName = this.resolveAssignedTeamAgent(team, subtask).agentName;
      const dependencySummary =
        subtask.dependencies.length > 0
          ? ` (depends on ${subtask.dependencies.length} task${subtask.dependencies.length === 1 ? "" : "s"})`
          : "";
      lines.push(`- ${subtask.title} -> ${agentName}${dependencySummary}`);
    }
    return lines.join("\n");
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
    const coordinator = team?.agents.find((agent) => agent.role === "coordinator");
    if (team && !coordinator) {
      throw new AppError(
        400,
        "INVALID_TEAM",
        "Team must have exactly 1 coordinator"
      );
    }
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

    this.store.setTasks(nextTasks);
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
      createdAt: now,
      updatedAt: now
    };
    this.store.createTeam(team);
    this.events.publish({ type: "team.updated", action: "created", teamId: team.id, team });
    return team;
  }

  public updateTeam(teamId: string, input: UpdateTeamBody): AgentTeam {
    const updates: Partial<Pick<AgentTeam, "name" | "description" | "agents" | "prStrategy">> = {};
    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.description !== undefined) updates.description = input.description.trim();
    if (input.agents !== undefined) {
      validateTeamAgents(input.agents);
      updates.agents = input.agents;
    }
    if (input.prStrategy !== undefined) updates.prStrategy = input.prStrategy;

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

}
