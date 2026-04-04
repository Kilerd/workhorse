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
import { createTaskWorktree } from "../lib/task-worktree.js";
import { resolveGlobalSettings } from "../lib/global-settings.js";
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
import { RunLifecycleService } from "./run-lifecycle-service.js";

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

  private readonly runLifecycle: RunLifecycleService;

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
      startTask: (taskId, opts) => this.runLifecycle.startTask(taskId, opts),
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
      topOrder: (column, excludingId) => this.topOrder(column, excludingId)
    });
    this.prMonitor = new PrMonitorService({
      store: this.store,
      events: this.events,
      gitWorktrees: this.gitWorktrees,
      githubPullRequests: this.githubPullRequests,
      startTask: (taskId, opts) => this.runLifecycle.startTask(taskId, opts),
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
      runnerType: input.runnerType,
      runnerConfig: input.runnerConfig,
      worktree,
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
    return this.runLifecycle.startTask(taskId, {
      targetOrder: input.order
    });
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

    const planPrompt = this.buildPlanPrompt();

    return this.runLifecycle.startTask(taskId, {
      allowedColumns: ["backlog", "todo"],
      runnerConfigOverride: {
        type: "claude",
        prompt: planPrompt,
        permissionMode: "plan"
      },
      runMetadata: { trigger: "plan_generation" },
      targetColumn: "backlog"
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
      targetColumn: "backlog"
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

  private buildPlanPrompt(): string {
    return [
      "You are a planning assistant. Thoroughly explore the codebase, understand existing patterns and architecture, then create a detailed implementation plan.",
      "Do NOT implement anything or modify any files. Only output the plan.",
      "",
      "Your plan MUST include the following sections in markdown format:",
      "",
      "## Motivation",
      "Why this change is needed. What problem does it solve or what value does it add.",
      "",
      "## Current State",
      "How the relevant code works today. Key files, functions, data flows involved.",
      "",
      "## Proposed Changes",
      "Detailed list of every file and function to modify or create, with a clear description of what changes and why.",
      "For each change, specify:",
      "- File path",
      "- What to add / modify / remove",
      "- The reasoning behind the change",
      "",
      "## Impact & Scope",
      "Which modules, APIs, tests, or downstream consumers are affected by this change.",
      "",
      "## Risks & Edge Cases",
      "Potential pitfalls, race conditions, backward compatibility concerns, or tricky edge cases to watch for.",
      "",
      "## Verification",
      "How to verify the change works: which tests to add or update, manual checks, commands to run.",
      "",
      "## Exit Criteria",
      "Concrete definition of done — what must be true for this task to be considered complete."
    ].join("\n");
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
