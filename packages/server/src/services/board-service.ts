import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import type {
  AppState,
  CreateTaskBody,
  CreateWorkspaceBody,
  DeleteResult,
  GlobalSettings,
  HealthCodexQuotaData,
  ListTasksQuery,
  Run,
  RunLogEntry,
  RunnerConfig,
  StartTaskBody,
  TaskInputBody,
  Task,
  TaskPullRequest,
  TaskWorktree,
  UpdateSettingsBody,
  UpdateTaskBody,
  UpdateWorkspaceBody,
  WorkspaceGitRef,
  Workspace
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
import { StateStore } from "../persistence/state-store.js";
import {
  CodexAppServerManager,
  type CodexAppServer
} from "../runners/codex-app-server-manager.js";
import { CodexAcpRunner } from "../runners/codex-acp-runner.js";
import { ClaudeCliRunner } from "../runners/claude-cli-runner.js";
import {
  buildContinuationRun,
  canContinueCodexRun,
  cloneRun,
  resolveContinuationCandidateRunId
} from "../runners/codex-continuation.js";
import type { RunnerAdapter, RunnerControl } from "../runners/types.js";
import { ShellRunner } from "../runners/shell-runner.js";
import { EventBus } from "../ws/event-bus.js";
import { GitWorktreeService } from "./git-worktree-service.js";
import {
  OpenRouterTaskIdentityGenerator,
  type TaskIdentityGenerator
} from "./openrouter-task-naming-service.js";
import {
  buildTaskPullRequestSummary,
  resolveTaskPullRequestSummary,
  resolveTaskPullRequestUrl,
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

interface ActiveRun {
  control: RunnerControl;
  stopRequested: boolean;
  runId: string;
  queue(work: () => Promise<void>): Promise<void>;
}

interface StartTaskOptions {
  allowedColumns?: Task["column"][];
  runnerConfigOverride?: RunnerConfig;
  runMetadata?: Record<string, string>;
  initialInputText?: string;
  targetOrder?: number;
  targetColumn?: Task["column"];
}

interface BoardServiceDependencies {
  gitWorktrees?: GitWorktreeService;
  githubPullRequests?: GitHubPullRequestProvider;
  codexAppServer?: CodexAppServer;
  taskIdentityGenerator?: TaskIdentityGenerator;
  workspaceRootPicker?: WorkspaceRootPicker;
  runners?: Record<string, RunnerAdapter>;
}

export type { GitReviewMonitorResult } from "./pr-monitor-service.js";

const COLUMN_ORDER: Record<Task["column"], number> = {
  backlog: 0,
  todo: 1,
  running: 2,
  review: 3,
  done: 4,
  archived: 5
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

  private readonly activeRuns = new Map<string, ActiveRun>();

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
    this.prMonitor = new PrMonitorService({
      store: this.store,
      events: this.events,
      gitWorktrees: this.gitWorktrees,
      githubPullRequests: this.githubPullRequests,
      startTask: (taskId, opts) => this.startTaskInternal(taskId, opts),
      updateTask: (taskId, input) => this.updateTask(taskId, input),
      syncPullRequestSnapshot: (taskId, next) =>
        this.syncTaskPullRequestSnapshot(taskId, next),
      isTaskActive: (taskId) => this.activeRuns.has(taskId),
      topOrder: (column, excludingId) => this.topOrder(column, excludingId)
    });
    this.aiReview = new AiReviewService({
      store: this.store,
      events: this.events,
      gitWorktrees: this.gitWorktrees,
      githubPullRequests: this.githubPullRequests,
      startTask: (taskId, opts) => this.startTaskInternal(taskId, opts),
      appendAndPublishRunOutput: (taskId, runId, entry) => this.appendAndPublishRunOutput(taskId, runId, entry),
      updateRunMetadata: (runId, metadata) => this.updateRunMetadata(runId, metadata),
      refreshPullRequestSnapshot: (task, workspace) => this.refreshTaskPullRequestSnapshotForReview(task, workspace),
      getSettings: () => this.getSettings(),
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

  public async initialize(): Promise<void> {
    await this.store.load();
    await this.recoverOrphanedRuns();
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
    this.ensureRunnerConfig(input.runnerType, input.runnerConfig);
    const taskId = createId();
    const worktree = workspace.isGitRepo
      ? createTaskWorktree(taskId, title, {
          workspace,
          branchLabel,
          baseRef: await this.gitWorktrees.resolveBaseRef(
            workspace,
            input.worktreeBaseRef
          )
        })
      : createTaskWorktree(taskId, title, {
          workspace,
          branchLabel
        });

    const now = new Date().toISOString();
    const column = input.column ?? "backlog";
    const task: Task = {
      id: taskId,
      title,
      description,
      workspaceId: workspace.id,
      column,
      order: input.order ?? this.nextOrder(column),
      runnerType: input.runnerType,
      runnerConfig: input.runnerConfig,
      worktree,
      createdAt: now,
      updatedAt: now
    };

    const tasks = [...this.store.listTasks(), task];
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
    return task;
  }

  public async deleteTask(taskId: string): Promise<DeleteResult> {
    if (this.activeRuns.has(taskId)) {
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

  public async pollGitReviewTasksForBaseUpdates(): Promise<GitReviewMonitorResult> {
    return this.prMonitor.poll();
  }

  public async stopTask(taskId: string): Promise<{ task: Task; run: Run }> {
    const active = this.activeRuns.get(taskId);
    if (!active) {
      throw new AppError(400, "TASK_NOT_RUNNING", "Task does not have an active run");
    }

    const run = ensure(
      this.store
        .listRuns()
        .find((entry) => entry.taskId === taskId && entry.status === "running"),
      404,
      "RUN_NOT_FOUND",
      "Run not found"
    );
    const task = this.requireTask(taskId);

    active.stopRequested = true;
    await active.control.stop();
    return { task, run };
  }

  public async sendTaskInput(
    taskId: string,
    input: TaskInputBody
  ): Promise<{ task: Task; run: Run }> {
    const text = input.text.trim();
    if (!text) {
      throw new AppError(400, "INVALID_TASK_INPUT", "Task input cannot be blank");
    }

    const task = this.requireTask(taskId);

    if (task.runnerType !== "codex") {
      throw new AppError(
        400,
        "TASK_INPUT_NOT_SUPPORTED",
        "Only Codex tasks accept live input"
      );
    }

    const active = this.activeRuns.get(taskId);
    if (!active) {
      if (task.column !== "review") {
        throw new AppError(
          409,
          "TASK_INPUT_NOT_AVAILABLE",
          "Task input is only available while a Codex task is running or in review"
        );
      }

      return this.startTaskInternal(taskId, {
        allowedColumns: ["review"],
        initialInputText: text
      });
    }

    if (!active.control.sendInput) {
      throw new AppError(
        400,
        "TASK_INPUT_NOT_SUPPORTED",
        "The active runner does not support live input"
      );
    }

    const run = this.requireRun(active.runId);

    await active.queue(async () => {
      await this.appendAndPublishRunOutput(
        task.id,
        run.id,
        this.createUserInputLogEntry(run.id, text)
      );
    });

    try {
      const result = await active.control.sendInput(text);
      if (result?.metadata) {
        await active.queue(async () => {
          await this.updateRunMetadata(run.id, result.metadata ?? {});
        });
      }
    } catch (error) {
      const inputError =
        error instanceof AppError
          ? error
          : new AppError(
              409,
              "TASK_INPUT_REJECTED",
              error instanceof Error ? error.message : String(error)
            );

      await active.queue(async () => {
        await this.appendAndPublishRunOutput(
          task.id,
          run.id,
          createRunLogEntry(run.id, {
            kind: "system",
            stream: "system",
            title: "Input error",
            text: `${inputError.message}\n`
          })
        );
      });

      throw inputError;
    }

    const updatedTask = this.requireTask(taskId);
    const updatedRun = this.requireRun(run.id);

    return {
      task: updatedTask,
      run: updatedRun
    };
  }

  public async cleanupTaskWorktree(taskId: string): Promise<Task> {
    if (this.activeRuns.has(taskId)) {
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

  public async planTask(taskId: string): Promise<{ task: Task; plan: string }> {
    const tasks = this.store.listTasks();
    const task = this.requireTask(taskId, tasks);

    if (task.column !== "backlog") {
      throw new AppError(
        409,
        "TASK_NOT_PLANNABLE",
        "Only backlog tasks can generate a plan"
      );
    }

    const workspace = this.requireWorkspace(task.workspaceId);

    if (workspace.isGitRepo) {
      task.worktree = await this.gitWorktrees.ensureTaskWorktree(workspace, task);
    }

    const plan = this.buildTaskPlan(task);
    task.description = plan;
    task.column = "todo";
    task.order = this.topOrder("todo", task.id);
    task.updatedAt = new Date().toISOString();

    this.store.setTasks(tasks);
    await this.store.save();
    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: task.id,
      task
    });

    return { task, plan };
  }

  public async requestTaskReview(taskId: string): Promise<{ task: Task; run: Run }> {
    if (this.activeRuns.has(taskId)) {
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
    return this.startTaskInternal(refreshedTask.id, {
      allowedColumns: ["review"],
      runnerConfigOverride: this.aiReview.buildManualReviewRunnerConfig(refreshedTask),
      runMetadata: this.aiReview.buildManualReviewRunMetadata(refreshedTask)
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

  private createUserInputLogEntry(runId: string, text: string): RunLogEntry {
    return createRunLogEntry(runId, {
      kind: "user",
      stream: "system",
      title: "User input",
      text
    });
  }

  private async appendAndPublishRunOutput(
    taskId: string,
    runId: string,
    entry: RunLogEntry
  ): Promise<void> {
    await this.store.appendLogEntry(runId, entry);
    this.events.publish({
      type: "run.output",
      taskId,
      runId,
      entry
    });
  }

  private async updateRunMetadata(
    runId: string,
    metadata: Record<string, string>
  ): Promise<Run> {
    const runs = this.store.listRuns();
    const run = this.requireRun(runId, runs);

    run.metadata = {
      ...(run.metadata ?? {}),
      ...metadata
    };

    this.store.setRuns(runs);
    await this.store.save();
    return run;
  }

  private async startTaskInternal(
    taskId: string,
    options: StartTaskOptions = {}
  ): Promise<{ task: Task; run: Run }> {
    if (this.activeRuns.has(taskId)) {
      throw new AppError(409, "TASK_ALREADY_RUNNING", "Task already has an active run");
    }

    const tasks = this.store.listTasks();
    const task = this.requireTask(taskId, tasks);
    this.ensureStartableTask(task, options.allowedColumns);
    const workspace = this.requireWorkspace(task.workspaceId);
    let executionWorkspace = workspace;

    if (workspace.isGitRepo) {
      task.worktree = await this.gitWorktrees.ensureTaskWorktree(workspace, task);
      executionWorkspace = {
        ...workspace,
        rootPath: task.worktree.path ?? workspace.rootPath
      };
    }

    const executionTask = options.runnerConfigOverride
      ? {
          ...task,
          runnerType: options.runnerConfigOverride.type,
          runnerConfig: options.runnerConfigOverride
        }
      : task;
    const currentRuns = this.store.listRuns();
    const previousRunId = resolveContinuationCandidateRunId(task, executionTask.runnerType);
    const previousRunEntry =
      previousRunId !== undefined
        ? currentRuns.find((entry) => entry.id === previousRunId)
        : undefined;
    const previousRun = previousRunEntry
      ? cloneRun(previousRunEntry)
      : undefined;
    const reusableRunEntry = canContinueCodexRun(
      executionTask.runnerType,
      previousRunEntry
    )
      ? previousRunEntry
      : undefined;
    const run: Run = reusableRunEntry
      ? buildContinuationRun(reusableRunEntry, (id) => this.store.createLogPath(id), options.runMetadata)
      : (() => {
          const runId = createId();
          return {
            id: runId,
            taskId: task.id,
            status: "queued",
            runnerType: executionTask.runnerType,
            command: "",
            startedAt: new Date().toISOString(),
            logFile: this.store.createLogPath(runId),
            metadata: options.runMetadata
          } satisfies Run;
        })();

    const runs = reusableRunEntry
      ? currentRuns.map((entry) => (entry.id === reusableRunEntry.id ? run : entry))
      : [...currentRuns, run];
    const taskIndex = tasks.findIndex((entry) => entry.id === task.id);
    const targetColumn = options.targetColumn ?? "running";
    tasks[taskIndex] = {
      ...task,
      column: targetColumn,
      order: options.targetOrder ?? this.topOrder(targetColumn, task.id),
      lastRunId: run.id,
      continuationRunId:
        executionTask.runnerType === "codex" ? run.id : task.continuationRunId,
      updatedAt: new Date().toISOString()
    };

    this.store.setRuns(runs);
    this.store.setTasks(tasks);
    await this.store.save();
    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: tasks[taskIndex].id,
      task: tasks[taskIndex]
    });

    if (options.initialInputText) {
      await this.appendAndPublishRunOutput(
        task.id,
        run.id,
        this.createUserInputLogEntry(run.id, options.initialInputText)
      );
    }

    const runner = this.runners[executionTask.runnerType];
    if (!runner) {
      throw new AppError(
        400,
        "RUNNER_NOT_SUPPORTED",
        `No runner available for ${executionTask.runnerType}`
      );
    }

    let outputChain = Promise.resolve();
    const queueOutput = (work: () => Promise<void>) => {
      const next = outputChain.then(work);
      outputChain = next.catch(() => {});
      return next;
    };

    try {
      const control = await runner.start(
        {
          run: {
            ...run,
            logFile: this.store.createLogPath(run.id)
          },
          previousRun,
          task: executionTask,
          workspace: executionWorkspace,
          inputText: options.initialInputText
        },
        {
          onOutput: async (output) => {
            await queueOutput(async () => {
              const entry = createRunLogEntry(run.id, output);
              await this.appendAndPublishRunOutput(task.id, run.id, entry);
            });
          },
          onExit: async (result) => {
            await outputChain;
            await this.transitionTaskRunToReview(task.id, run.id, {
              status: this.activeRuns.get(task.id)?.stopRequested
                ? "canceled"
                : result.status,
              exitCode: result.exitCode,
              metadata: result.metadata
            });
          }
        }
      );

      run.status = "running";
      run.command = control.command;
      run.pid = control.pid;
      run.logFile = this.store.createLogPath(run.id);
      run.metadata = {
        ...(run.metadata ?? {}),
        ...(control.metadata ?? {})
      };
      this.store.setRuns(runs);
      await this.store.save();

      this.activeRuns.set(task.id, {
        control,
        stopRequested: false,
        runId: run.id,
        queue: queueOutput
      });

      this.events.publish({
        type: "run.started",
        taskId: task.id,
        run
      });

      return {
        task: tasks[taskIndex],
        run
      };
    } catch (error) {
      run.status = "failed";
      run.endedAt = new Date().toISOString();
      const entry = createRunLogEntry(run.id, {
        kind: "system",
        stream: "system",
        text: `${error instanceof Error ? error.message : String(error)}\n`,
        title: "Runner error"
      });
      await this.appendAndPublishRunOutput(task.id, run.id, entry);
      tasks[taskIndex] = {
        ...tasks[taskIndex],
        column: "review",
        order: this.topOrder("review", task.id),
        updatedAt: new Date().toISOString()
      };
      this.store.setRuns(runs);
      this.store.setTasks(tasks);
      await this.store.save();
      this.events.publish({
        type: "task.updated",
        action: "updated",
        taskId: tasks[taskIndex].id,
        task: tasks[taskIndex]
      });
      this.events.publish({
        type: "run.finished",
        taskId: tasks[taskIndex].id,
        run,
        task: tasks[taskIndex]
      });
      throw error;
    }
  }



  private async archiveTaskCodexThread(task: Task): Promise<void> {
    const runId = task.continuationRunId ?? task.lastRunId;
    if (this.activeRuns.has(task.id) || !runId) {
      return;
    }

    const run = this.store.listRuns().find((entry) => entry.id === runId);
    const threadId =
      run?.runnerType === "codex"
        ? run.metadata?.threadId?.trim()
        : undefined;
    if (!threadId) {
      return;
    }

    try {
      await this.codexAppServer.archiveThread(threadId);
    } catch {
      // Archiving the remote thread is best-effort and should not block task completion.
    }
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

  private async recoverOrphanedRuns(): Promise<void> {
    const runs = this.store.listRuns();
    for (const run of runs) {
      if (run.status !== "queued" && run.status !== "running") {
        continue;
      }

      await this.transitionTaskRunToReview(run.taskId, run.id, {
        status: this.resolveOrphanedRunStatus(run)
      });
    }
  }

  private async transitionTaskRunToReview(
    taskId: string,
    runId: string,
    result: {
      status: Run["status"];
      exitCode?: number;
      metadata?: Record<string, string>;
    }
  ): Promise<{ run: Run; task: Task }> {
    const currentRuns = this.store.listRuns();
    const currentTasks = this.store.listTasks();
    const runEntry = this.requireRun(runId, currentRuns);
    const taskEntry = this.requireTask(taskId, currentTasks);

    runEntry.status = result.status;
    runEntry.exitCode = result.exitCode;
    runEntry.endedAt = new Date().toISOString();
    runEntry.metadata = result.metadata
      ? {
          ...(runEntry.metadata ?? {}),
          ...result.metadata
        }
      : runEntry.metadata;
    this.activeRuns.delete(taskId);

    const shouldAutoReview = this.aiReview.shouldAutoTriggerAiReview(taskEntry, runEntry, result.status);
    const isAiReviewRun = this.aiReview.isAiReviewTrigger(runEntry.metadata?.trigger);
    const shouldRework =
      isAiReviewRun &&
      result.status === "succeeded" &&
      runEntry.metadata?.reviewVerdict === "request_changes";
    const nextColumn: Task["column"] =
      shouldAutoReview || shouldRework ? "running" : "review";

    taskEntry.column = nextColumn;
    taskEntry.order = this.topOrder(nextColumn, taskId);
    taskEntry.pullRequestUrl = resolveTaskPullRequestUrl(taskEntry, runEntry);
    taskEntry.pullRequest = resolveTaskPullRequestSummary(taskEntry, runEntry);
    taskEntry.updatedAt = new Date().toISOString();

    this.store.setRuns(currentRuns);
    this.store.setTasks(currentTasks);
    await this.store.save();
    if (isAiReviewRun) {
      await this.aiReview.maybePublishManualReviewToPullRequest(taskEntry, runEntry);
    }
    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: taskEntry.id,
      task: taskEntry
    });

    this.events.publish({
      type: "run.finished",
      taskId: taskEntry.id,
      run: runEntry,
      task: taskEntry
    });

    if (shouldAutoReview) {
      void this.aiReview.triggerAiReview(taskEntry).catch(() => {});
    }

    if (shouldRework) {
      void this.aiReview.triggerReworkFromReview(taskEntry, runEntry).catch(() => {});
    }

    return {
      run: runEntry,
      task: taskEntry
    };
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

  private ensureStartableTask(
    task: Task,
    allowedColumns: Task["column"][] = ["backlog", "todo", "review"]
  ): void {
    if (allowedColumns.includes(task.column)) {
      return;
    }

    throw new AppError(
      409,
      "TASK_NOT_STARTABLE",
      `Tasks in ${task.column} cannot be started`
    );
  }

  private buildTaskPlan(task: Task): string {
    const description = task.description.trim();
    const context = description || "No additional context provided yet.";
    const executionHint =
      task.runnerType === "codex"
        ? "Use the Codex runner to implement the task in small, verifiable steps."
        : task.runnerType === "claude"
          ? "Use the Claude CLI runner to execute the task in small, verifiable steps."
        : "Use the shell runner to execute the task in small, verifiable steps.";

    return [
      "# Plan",
      "## Objective",
      task.title,
      "## Context",
      context,
      "## Steps",
      "1. Confirm the expected outcome and any repo-specific constraints.",
      "2. Break the work into one or two concrete implementation steps.",
      `3. ${executionHint}`,
      "4. Verify the result with the smallest useful test or smoke check.",
      "## Exit Criteria",
      "- The task result is visible or testable.",
      "- For Git-backed Codex tasks, the agent creates or updates a GitHub PR before finishing.",
      "- Any follow-up work is captured before moving to review."
    ].join("\n\n");
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

  private resolveOrphanedRunStatus(run: Run): Run["status"] {
    if (
      run.runnerType === "codex" &&
      (run.status === "running" || typeof run.metadata?.threadId === "string")
    ) {
      return "interrupted";
    }

    return "canceled";
  }
}
