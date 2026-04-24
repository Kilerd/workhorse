import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  AccountAgent,
  AgentRole,
  AppState,
  CreateAgentBody,
  CreateTaskBody,
  CreateWorkspaceBody,
  DeleteResult,
  GlobalSettings,
  HealthCodexQuotaData,
  ListTasksQuery,
  MountAgentBody,
  Run,
  RunnerConfig,
  StartTaskBody,
  TaskInputBody,
  Task,
  TaskPullRequest,
  TaskWorktree,
  UpdateAgentBody,
  UpdateAgentRoleBody,
  UpdateSettingsBody,
  UpdateTaskBody,
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
import { createTaskWorktree } from "../lib/task-worktree.js";
import { resolveGlobalSettings } from "../lib/global-settings.js";
import { resolveWorkspacePromptTemplates } from "../lib/workspace-prompt-templates.js";
import { StateStore } from "../persistence/state-store.js";
import {
  CodexAppServerManager,
  type CodexAppServer
} from "../runners/codex-app-server-manager.js";
import { CodexAcpRunner } from "../runners/codex-acp-runner.js";
import { ClaudeCliRunner } from "../runners/claude-cli-runner.js";
import { synthesizeAgentPrompt } from "../runners/builtin-prompts.js";
import type { RunnerAdapter } from "../runners/types.js";
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

interface BoardServiceDependencies {
  gitWorktrees?: GitWorktreeService;
  githubPullRequests?: GitHubPullRequestProvider;
  codexAppServer?: CodexAppServer;
  taskIdentityGenerator?: TaskIdentityGenerator;
  workspaceRootPicker?: WorkspaceRootPicker;
  runners?: Record<string, RunnerAdapter>;
}

export type { GitReviewMonitorResult } from "./pr-monitor-service.js";

function applyAgentPromptSynthesis(
  runnerConfig: RunnerConfig,
  description: string | undefined
): RunnerConfig {
  const synthesized = synthesizeAgentPrompt(runnerConfig.type, description);
  return { ...runnerConfig, prompt: synthesized };
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
      resolveRunnerConfig: (task) => this.resolveTaskRunnerConfig(task),
      topOrder: (column, excludingId) => this.topOrder(column, excludingId),
      canTaskStart: (task, source) => this.canTaskStart(task, source),
      evaluateScheduler: () => this.scheduler.evaluate()
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
        },
        resolveRunnerType: (task) => this.resolveTaskRunnerConfig(task).type
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
      resolveRunnerConfig: (task) => this.resolveTaskRunnerConfig(task),
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

  private resolveCreateTaskAssignee(
    workspaceId: string,
    requestedAgentId?: string
  ): string | undefined {
    const workspaceAgents = this.store.listWorkspaceAgents(workspaceId);
    const requested = requestedAgentId?.trim();
    if (requested) {
      const assigned = workspaceAgents.find((agent) => agent.id === requested);
      if (!assigned) {
        throw new AppError(
          400,
          "TASK_ASSIGNEE_NOT_FOUND",
          `Agent ${requested} is not mounted in this workspace`
        );
      }
      return assigned.id;
    }

    return (
      workspaceAgents.find((agent) => agent.role === "worker") ??
      workspaceAgents.find((agent) => agent.role === "coordinator")
    )?.id;
  }

  private resolveTaskRunnerConfig(task: Task): RunnerConfig {
    const workspaceAgents = this.store.listWorkspaceAgents(task.workspaceId);
    const assigned = task.assigneeAgentId
      ? workspaceAgents.find((agent) => agent.id === task.assigneeAgentId)
      : undefined;

    if (task.assigneeAgentId && !assigned) {
      throw new AppError(
        400,
        "TASK_ASSIGNEE_NOT_FOUND",
        `Task ${task.id} is assigned to an agent that is not mounted in this workspace`
      );
    }

    const fallback =
      assigned ??
      workspaceAgents.find((agent) => agent.role === "worker") ??
      workspaceAgents.find((agent) => agent.role === "coordinator");

    if (!fallback) {
      throw new AppError(
        400,
        "TASK_AGENT_NOT_ASSIGNED",
        "Assign the task to a mounted agent before starting it"
      );
    }

    return structuredClone(fallback.runnerConfig);
  }

  private async startTaskInternal(
    taskId: string,
    options: StartTaskOptions = {}
  ): Promise<{ task: Task; run: Run }> {
    const task = this.requireTask(taskId);
    return this.runLifecycle.startTask(taskId, {
      ...options,
      runnerConfigOverride:
        options.runnerConfigOverride ?? this.resolveTaskRunnerConfig(task)
    });
  }

  private async checkAndHandleParentCompletion(parentTaskId: string): Promise<void> {
    const result = await this.store.updateState((state) => {
      const subtasks = state.tasks.filter(
        (t) => t.parentTaskId === parentTaskId
      );
      if (subtasks.length === 0) {
        return null;
      }

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

      return { parent: { ...parent } };
    });

    if (!result) {
      return;
    }

    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: result.parent.id,
      task: result.parent
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
    const hasTasks = this.store
      .listTasks()
      .some((task) => task.workspaceId === workspaceId);
    if (hasTasks) {
      throw new AppError(
        409,
        "WORKSPACE_HAS_TASKS",
        "Delete the workspace tasks before removing the workspace"
      );
    }

    const removedTaskIds = new Set(
      this.store
        .listTasks()
        .filter((task) => task.workspaceId === workspaceId)
        .map((task) => task.id)
    );
    const nextTasks = this.store
      .listTasks()
      .filter((task) => task.workspaceId !== workspaceId);
    const nextRuns = this.store
      .listRuns()
      .filter((run) => !removedTaskIds.has(run.taskId));
    const nextWorkspaces = this.store
      .listWorkspaces()
      .filter((workspace) => workspace.id !== workspaceId);
    if (nextWorkspaces.length === this.store.listWorkspaces().length) {
      throw new AppError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }

    this.store.setTasks(nextTasks);
    this.store.setRuns(nextRuns);
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
    const assigneeAgentId = this.resolveCreateTaskAssignee(workspace.id, input.assigneeAgentId);
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
      dependencies: [],
      worktree,
      rejected: false,
      taskKind: "user",
      assigneeAgentId,
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
    if (input.assigneeAgentId !== undefined) {
      task.assigneeAgentId = input.assigneeAgentId.trim()
        ? this.resolveCreateTaskAssignee(nextWorkspace.id, input.assigneeAgentId)
        : undefined;
    }
    const nextColumn = input.column ?? task.column;
    const columnChanged = nextColumn !== task.column;
    task.column = nextColumn;
    task.order =
      input.order ??
      (columnChanged ? this.nextOrder(nextColumn) : task.order);
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

  public async approveTask(taskId: string): Promise<Task> {
    const { task, parentTask } = this.requireReviewableSubtask(taskId);
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
    await this.checkAndHandleParentCompletion(parentTask.id);
    return approvedTask;
  }

  public async rejectTask(taskId: string, reason?: string): Promise<Task> {
    const { task, parentTask } = this.requireReviewableSubtask(taskId);
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
    await this.checkAndHandleParentCompletion(parentTask.id);
    return rejectedTask;
  }

  public async retryTask(taskId: string): Promise<Task> {
    const { task, parentTask } = this.requireReviewableSubtask(taskId);

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

    await this.evaluateScheduler();
    return this.requireTask(taskId);
  }


  private requireSubtask(taskId: string): {
    task: Task;
    parentTask: Task;
  } {
    const task = this.requireTask(taskId);
    if (!task.parentTaskId) {
      throw new AppError(409, "TASK_NOT_SUBTASK", "Task is not a subtask");
    }

    const parentTask = this.requireTask(task.parentTaskId);
    if (parentTask.parentTaskId) {
      throw new AppError(
        409,
        "INVALID_PARENT_TASK",
        "parentTaskId must reference a parent coordinator task"
      );
    }
    return { task, parentTask };
  }

  private requireReviewableSubtask(taskId: string): {
    task: Task;
    parentTask: Task;
  } {
    const { task, parentTask } = this.requireSubtask(taskId);
    if (task.column !== "review") {
      throw new AppError(409, "TASK_NOT_REVIEWABLE", "Only review subtasks can be changed");
    }

    return { task, parentTask };
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
      runnerConfig: applyAgentPromptSynthesis(body.runnerConfig, body.description),
      createdAt: now,
      updatedAt: now
    };
    const created = this.store.createAgent(agent);
    this.events.publish({
      type: "agent.updated",
      action: "created",
      agentId: created.id,
      agent: created
    });
    return created;
  }

  public getAgent(agentId: string): AccountAgent {
    const agent = this.store.getAgent(agentId);
    if (!agent) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    }
    return agent;
  }

  public async updateAgent(agentId: string, body: UpdateAgentBody): Promise<AccountAgent> {
    const existing = this.store.getAgent(agentId);
    if (!existing) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    }
    const nextDescription =
      body.description !== undefined ? body.description : existing.description;
    const nextRunnerConfig = body.runnerConfig
      ? applyAgentPromptSynthesis(body.runnerConfig, nextDescription)
      : applyAgentPromptSynthesis(existing.runnerConfig, nextDescription);
    const updated = this.store.updateAgent(agentId, {
      ...body,
      runnerConfig: nextRunnerConfig
    });
    if (!updated) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    }
    this.events.publish({
      type: "agent.updated",
      action: "updated",
      agentId: updated.id,
      agent: updated
    });
    return updated;
  }

  public deleteAgent(agentId: string): void {
    const deleted = this.store.deleteAgent(agentId);
    if (!deleted) {
      throw new AppError(404, "AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    }
    this.events.publish({
      type: "agent.updated",
      action: "deleted",
      agentId
    });
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
    const agent = this.store.mountAgentToWorkspace(
      workspaceId,
      body.agentId,
      body.role as AgentRole,
      body.workspaceDescription
    );
    this.events.publish({
      type: "workspace.agent.updated",
      action: "mounted",
      workspaceId,
      agentId: agent.id,
      agent
    });
    return agent;
  }

  public unmountAgent(workspaceId: string, agentId: string): void {
    this.requireWorkspace(workspaceId);
    const existing = this.store.getWorkspaceAgent(workspaceId, agentId);
    const removed = this.store.unmountAgentFromWorkspace(workspaceId, agentId);
    if (!removed) {
      throw new AppError(404, "WORKSPACE_AGENT_NOT_FOUND", `Agent ${agentId} not mounted in workspace ${workspaceId}`);
    }
    this.events.publish({
      type: "workspace.agent.updated",
      action: "unmounted",
      workspaceId,
      agentId,
      ...(existing ? { agent: existing } : {})
    });
  }

  public updateAgentRole(
    workspaceId: string,
    agentId: string,
    body: UpdateAgentRoleBody
  ): WorkspaceAgent {
    this.requireWorkspace(workspaceId);
    const updated = this.store.updateWorkspaceAgent(workspaceId, agentId, {
      role: body.role as AgentRole | undefined,
      workspaceDescription: body.workspaceDescription
    });
    if (!updated) {
      throw new AppError(404, "WORKSPACE_AGENT_NOT_FOUND", `Agent ${agentId} not mounted in workspace ${workspaceId}`);
    }
    this.events.publish({
      type: "workspace.agent.updated",
      action: "updated",
      workspaceId,
      agentId: updated.id,
      agent: updated
    });
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
    this.events.publish({
      type: "workspace.updated",
      action: "updated",
      workspaceId: updated.id,
      workspace: updated
    });
    return updated;
  }


}
