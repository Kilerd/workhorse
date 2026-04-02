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
  TaskInputBody,
  Task,
  TaskPullRequest,
  TaskPullRequestChecks,
  TaskPullRequestFile,
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
  type GitHubCheckBucket,
  type GitHubPullRequestCheck,
  type GitHubPullRequestFile,
  type GitHubPullRequestProvider,
  type GitHubPullRequestSummary
} from "../lib/github.js";
import { resolveWorkspaceCodexSettings } from "../lib/codex-settings.js";
import { createId } from "../lib/id.js";
import { createRunLogEntry } from "../lib/run-log.js";
import { createTaskWorktree } from "../lib/task-worktree.js";
import { resolveGlobalSettings } from "../lib/global-settings.js";
import { StateStore } from "../persistence/state-store.js";
import {
  CodexAppServerManager,
  type CodexAppServer
} from "../runners/codex-app-server-manager.js";
import { CodexAcpRunner } from "../runners/codex-acp-runner.js";
import type { RunnerAdapter, RunnerControl } from "../runners/types.js";
import { ShellRunner } from "../runners/shell-runner.js";
import { EventBus } from "../ws/event-bus.js";
import { GitWorktreeService } from "./git-worktree-service.js";
import {
  OpenRouterTaskIdentityGenerator,
  type TaskIdentityGenerator
} from "./openrouter-task-naming-service.js";

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
}

type MonitorCiStatus = GitHubCheckBucket | "not_required";

type MonitorReasonCode =
  | "behind"
  | "conflict"
  | "ci_failed"
  | "new_feedback"
  | "unresolved_conversations";

interface MonitorReason {
  code: MonitorReasonCode;
  description: string;
}

interface BoardServiceDependencies {
  gitWorktrees?: GitWorktreeService;
  githubPullRequests?: GitHubPullRequestProvider;
  codexAppServer?: CodexAppServer;
  taskIdentityGenerator?: TaskIdentityGenerator;
}

export interface GitReviewMonitorResult {
  available: boolean;
  resumedTaskIds: string[];
  skippedTaskIds: string[];
}

const COLUMN_ORDER: Record<Task["column"], number> = {
  backlog: 0,
  todo: 1,
  running: 2,
  review: 3,
  done: 4,
  archived: 5
};

function toOptionalNumber(value?: string): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class BoardService {
  private readonly store: StateStore;

  private readonly events: EventBus;

  private readonly runners: Record<string, RunnerAdapter>;

  private readonly gitWorktrees: GitWorktreeService;

  private readonly githubPullRequests: GitHubPullRequestProvider;

  private readonly codexAppServer: CodexAppServer;

  private readonly taskIdentityGenerator: TaskIdentityGenerator;

  private readonly activeRuns = new Map<string, ActiveRun>();

  private reviewMonitorLastPolledAt?: string;

  public constructor(
    store: StateStore,
    events: EventBus,
    dependencies: BoardServiceDependencies = {}
  ) {
    this.store = store;
    this.events = events;
    this.codexAppServer = dependencies.codexAppServer ?? new CodexAppServerManager();
    this.runners = {
      shell: new ShellRunner(),
      codex: new CodexAcpRunner(this.codexAppServer)
    };
    this.gitWorktrees = dependencies.gitWorktrees ?? new GitWorktreeService();
    this.githubPullRequests =
      dependencies.githubPullRequests ?? new GhCliPullRequestProvider();
    this.taskIdentityGenerator =
      dependencies.taskIdentityGenerator ?? new OpenRouterTaskIdentityGenerator();
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
    return this.reviewMonitorLastPolledAt;
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
    const workspace = ensure(
      this.store.listWorkspaces().find((entry) => entry.id === workspaceId),
      404,
      "WORKSPACE_NOT_FOUND",
      "Workspace not found"
    );

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
    const workspace = ensure(
      workspaces.find((entry) => entry.id === workspaceId),
      404,
      "WORKSPACE_NOT_FOUND",
      "Workspace not found"
    );

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
    const workspace = ensure(
      this.store.listWorkspaces().find((entry) => entry.id === input.workspaceId),
      404,
      "WORKSPACE_NOT_FOUND",
      "Workspace not found"
    );

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
    const task = ensure(
      tasks.find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );
    const currentWorkspace = ensure(
      this.store.listWorkspaces().find((entry) => entry.id === task.workspaceId),
      404,
      "WORKSPACE_NOT_FOUND",
      "Workspace not found"
    );
    const nextWorkspace =
      input.workspaceId !== undefined
        ? ensure(
            this.store.listWorkspaces().find((entry) => entry.id === input.workspaceId),
            404,
            "WORKSPACE_NOT_FOUND",
            "Workspace not found"
          )
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

    const task = ensure(
      this.store.listTasks().find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );
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

  public async startTask(taskId: string): Promise<{ task: Task; run: Run }> {
    return this.startTaskInternal(taskId);
  }

  public async pollGitReviewTasksForBaseUpdates(): Promise<GitReviewMonitorResult> {
    const polledAt = new Date().toISOString();
    this.reviewMonitorLastPolledAt = polledAt;
    this.events.publish({
      type: "runtime.review-monitor.polled",
      polledAt
    });

    if (!(await this.githubPullRequests.isAvailable())) {
      return {
        available: false,
        resumedTaskIds: [],
        skippedTaskIds: []
      };
    }

    const workspaces = this.store.listWorkspaces();
    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const runsById = new Map(this.store.listRuns().map((run) => [run.id, run]));
    const reviewTasksByWorkspace = new Map<string, Task[]>();

    for (const task of this.store.listTasks()) {
      if (task.column !== "review" || this.activeRuns.has(task.id)) {
        continue;
      }

      const workspace = workspaceById.get(task.workspaceId);
      if (!workspace?.isGitRepo || task.worktree.status === "removed") {
        continue;
      }

      const current = reviewTasksByWorkspace.get(workspace.id) ?? [];
      current.push(task);
      reviewTasksByWorkspace.set(workspace.id, current);
    }

    const resumedTaskIds: string[] = [];
    const skippedTaskIds: string[] = [];

    for (const [workspaceId, tasks] of reviewTasksByWorkspace.entries()) {
      const workspace = workspaceById.get(workspaceId);
      if (!workspace) {
        continue;
      }

      const repositoryFullName = await this.gitWorktrees.getGitHubRepositoryFullName(workspace);
      if (!repositoryFullName) {
        continue;
      }

      try {
        for (const remoteName of new Set(tasks.map((task) => this.extractRemoteName(task.worktree.baseRef)))) {
          await this.gitWorktrees.fetchWorkspace(workspace, remoteName);
        }
      } catch {
        skippedTaskIds.push(...tasks.map((task) => task.id));
        continue;
      }

      for (const task of tasks) {
        try {
          const openPr = await this.githubPullRequests.findOpenPullRequest(
            repositoryFullName,
            task.worktree.branchName
          );

          if (!openPr) {
            await this.syncTaskPullRequestSnapshot(task.id, {
              pullRequest: null
            });
            const mergedPr = await this.githubPullRequests.findMergedPullRequest(
              repositoryFullName,
              task.worktree.branchName
            );
            if (mergedPr && this.baseRefMatches(task.worktree.baseRef, mergedPr.baseRef)) {
              await this.updateTask(task.id, {
                column: "done",
                order: this.topOrder("done", task.id)
              });
            }
            continue;
          }

          const checks = await this.githubPullRequests.listRequiredChecks(
            repositoryFullName,
            openPr.number
          );
          await this.syncTaskPullRequestSnapshot(task.id, {
            pullRequestUrl: openPr.url,
            pullRequest: this.buildTaskPullRequestSummary(openPr, checks)
          });
          const ciStatus = this.summarizeRequiredChecks(checks);
          const monitorReasons = this.collectMonitorReasons(task, runsById, openPr, ciStatus);
          if (monitorReasons.length === 0) {
            continue;
          }
          if (this.wasMonitorRunAlreadyAttempted(task, runsById, openPr, ciStatus)) {
            continue;
          }

          const shouldCommentOnUnresolvedConversations =
            this.shouldCommentOnUnresolvedConversations(task, runsById, openPr);
          await this.startTaskInternal(task.id, {
            allowedColumns: ["review"],
            runnerConfigOverride: this.buildMonitorRunnerConfig(
              task,
              openPr,
              ciStatus,
              monitorReasons
            ),
            runMetadata: this.buildMonitorRunMetadata(openPr, ciStatus, checks)
          });
          resumedTaskIds.push(task.id);
          if (shouldCommentOnUnresolvedConversations) {
            await this.postUnresolvedConversationComment(
              repositoryFullName,
              task,
              openPr
            );
          }
        } catch {
          skippedTaskIds.push(task.id);
        }
      }
    }

    return {
      available: true,
      resumedTaskIds,
      skippedTaskIds
    };
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
    const task = ensure(
      this.store.listTasks().find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );

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

    const task = ensure(
      this.store.listTasks().find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );

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

    const run = ensure(
      this.store.listRuns().find((entry) => entry.id === active.runId),
      404,
      "RUN_NOT_FOUND",
      "Run not found"
    );

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

    const updatedTask = ensure(
      this.store.listTasks().find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );
    const updatedRun = ensure(
      this.store.listRuns().find((entry) => entry.id === run.id),
      404,
      "RUN_NOT_FOUND",
      "Run not found"
    );

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
    const task = ensure(
      tasks.find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );
    const workspace = ensure(
      this.store.listWorkspaces().find((entry) => entry.id === task.workspaceId),
      404,
      "WORKSPACE_NOT_FOUND",
      "Workspace not found"
    );

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
    const task = ensure(
      tasks.find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );

    if (task.column !== "backlog") {
      throw new AppError(
        409,
        "TASK_NOT_PLANNABLE",
        "Only backlog tasks can generate a plan"
      );
    }

    const workspace = ensure(
      this.store.listWorkspaces().find((entry) => entry.id === task.workspaceId),
      404,
      "WORKSPACE_NOT_FOUND",
      "Workspace not found"
    );

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

  public listRuns(taskId: string): Run[] {
    const exists = this.store.listTasks().some((task) => task.id === taskId);
    if (!exists) {
      throw new AppError(404, "TASK_NOT_FOUND", "Task not found");
    }

    return this.store
      .listRuns()
      .filter((run) => run.taskId === taskId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  public async getRunLog(runId: string) {
    const run = this.store.listRuns().find((entry) => entry.id === runId);
    if (!run) {
      throw new AppError(404, "RUN_NOT_FOUND", "Run not found");
    }

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
    const run = ensure(
      runs.find((entry) => entry.id === runId),
      404,
      "RUN_NOT_FOUND",
      "Run not found"
    );

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
    const task = ensure(
      tasks.find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );
    this.ensureStartableTask(task, options.allowedColumns);
    const workspace = ensure(
      this.store.listWorkspaces().find((entry) => entry.id === task.workspaceId),
      404,
      "WORKSPACE_NOT_FOUND",
      "Workspace not found"
    );
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
    const previousRunEntry =
      task.lastRunId !== undefined
        ? currentRuns.find((entry) => entry.id === task.lastRunId)
        : undefined;
    const previousRun = previousRunEntry
      ? this.cloneRun(previousRunEntry)
      : undefined;
    const reusableRunEntry = this.canContinueCodexRun(
      executionTask.runnerType,
      previousRunEntry
    )
      ? previousRunEntry
      : undefined;
    const run: Run = reusableRunEntry
      ? this.buildContinuationRun(reusableRunEntry, options.runMetadata)
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
    tasks[taskIndex] = {
      ...task,
      column: "running",
      order: this.topOrder("running", task.id),
      lastRunId: run.id,
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

  private cloneRun(run: Run): Run {
    return {
      ...run,
      metadata: run.metadata ? { ...run.metadata } : undefined
    };
  }

  private canContinueCodexRun(
    runnerType: Run["runnerType"],
    previousRun?: Run
  ): previousRun is Run {
    if (runnerType !== "codex" || previousRun?.runnerType !== "codex") {
      return false;
    }

    return Boolean(previousRun.metadata?.threadId?.trim());
  }

  private buildContinuationRun(
    previousRun: Run,
    runMetadata?: Record<string, string>
  ): Run {
    return {
      id: previousRun.id,
      taskId: previousRun.taskId,
      status: "queued",
      runnerType: previousRun.runnerType,
      command: "",
      startedAt: new Date().toISOString(),
      logFile: this.store.createLogPath(previousRun.id),
      metadata: this.buildContinuationRunMetadata(previousRun.metadata, runMetadata)
    };
  }

  private buildContinuationRunMetadata(
    previousMetadata?: Record<string, string>,
    nextMetadata?: Record<string, string>
  ): Record<string, string> | undefined {
    const metadata = {
      ...(previousMetadata?.threadId ? { threadId: previousMetadata.threadId } : {}),
      ...(previousMetadata?.turnId ? { turnId: previousMetadata.turnId } : {}),
      ...(previousMetadata?.prUrl ? { prUrl: previousMetadata.prUrl } : {}),
      ...(nextMetadata ?? {})
    };

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private async archiveTaskCodexThread(task: Task): Promise<void> {
    if (this.activeRuns.has(task.id) || !task.lastRunId) {
      return;
    }

    const run = this.store.listRuns().find((entry) => entry.id === task.lastRunId);
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

  private collectMonitorReasons(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus
  ): MonitorReason[] {
    if (!this.baseRefMatches(task.worktree.baseRef, pullRequest.baseRef)) {
      return [];
    }

    const reasons: MonitorReason[] = [];
    const mergeable = pullRequest.mergeable?.toUpperCase();
    const mergeStateStatus = pullRequest.mergeStateStatus?.toUpperCase();
    if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
      reasons.push({
        code: "conflict",
        description: "the PR conflicts with its base branch"
      });
    } else if (mergeStateStatus === "BEHIND") {
      reasons.push({
        code: "behind",
        description: "the PR is behind its base branch"
      });
    }

    if (this.hasFailingPullRequestCi(pullRequest, ciStatus)) {
      reasons.push({
        code: "ci_failed",
        description: "the PR has failing CI checks"
      });
    }

    if (this.hasUnresolvedPullRequestConversations(task, runsById, pullRequest)) {
      reasons.push({
        code: "unresolved_conversations",
        description: "the PR has unresolved review conversations"
      });
    }

    if (this.hasNewPullRequestFeedback(task, runsById, pullRequest)) {
      reasons.push({
        code: "new_feedback",
        description: "the PR has new comments or review feedback"
      });
    }

    return reasons;
  }

  private wasMonitorRunAlreadyAttempted(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus
  ): boolean {
    if (!task.lastRunId) {
      return false;
    }

    const run = runsById.get(task.lastRunId);
    if (!run?.metadata || run.metadata.trigger !== "gh_pr_monitor") {
      return false;
    }

    if (run.status !== "succeeded") {
      return false;
    }

    return (
      run.metadata.monitorPrNumber === String(pullRequest.number) &&
      run.metadata.monitorPrHeadSha === (pullRequest.headSha ?? "") &&
      run.metadata.monitorPrBaseSha === (pullRequest.baseSha ?? "") &&
      run.metadata.monitorPrMergeState === (pullRequest.mergeStateStatus ?? "") &&
      run.metadata.monitorPrMergeable === (pullRequest.mergeable ?? "") &&
      run.metadata.monitorPrCiStatus === ciStatus &&
      run.metadata.monitorPrStatusCheckRollupState ===
        (pullRequest.statusCheckRollupState ?? "") &&
      run.metadata.monitorPrFeedbackCount === String(pullRequest.feedbackCount ?? 0) &&
      run.metadata.monitorPrFeedbackUpdatedAt === (pullRequest.feedbackUpdatedAt ?? "") &&
      run.metadata.monitorPrUnresolvedConversationCount ===
        String(pullRequest.unresolvedConversationCount ?? 0) &&
      run.metadata.monitorPrUnresolvedConversationUpdatedAt ===
        (pullRequest.unresolvedConversationUpdatedAt ?? "") &&
      run.metadata.monitorPrUnresolvedConversationSignature ===
        this.buildUnresolvedConversationSignature(pullRequest)
    );
  }

  private buildMonitorRunnerConfig(
    task: Task,
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus,
    reasons: MonitorReason[]
  ): RunnerConfig {
    if (task.runnerConfig.type === "shell") {
      return {
        ...task.runnerConfig,
        command: [
          "set -eu",
          `git fetch ${this.quoteShell(this.extractRemoteName(task.worktree.baseRef))} --prune`,
          `git rebase ${this.quoteShell(task.worktree.baseRef)}`,
          task.runnerConfig.command.trim()
        ].join("\n")
      };
    }

    const feedbackLines = this.formatMonitorFeedback(pullRequest);
    const unresolvedConversationLines = this.formatMonitorUnresolvedConversations(pullRequest);
    return {
      ...task.runnerConfig,
      prompt: [
        task.runnerConfig.prompt.trim(),
        "GitHub PR monitor update:",
        `- PR #${pullRequest.number} (${pullRequest.url}) needs attention because ${this.joinMonitorReasonDescriptions(reasons)}.`,
        `- Required CI status is currently \`${ciStatus}\`.`,
        pullRequest.statusCheckRollupState
          ? `- Overall PR check rollup is \`${pullRequest.statusCheckRollupState}\`.`
          : undefined,
        pullRequest.reviewDecision
          ? `- Review decision is \`${pullRequest.reviewDecision}\`.`
          : undefined,
        feedbackLines.length > 0 ? "- Recent PR feedback to address:" : undefined,
        ...feedbackLines.map((line) => `  - ${line}`),
        unresolvedConversationLines.length > 0
          ? "- Unresolved review conversations to address:"
          : undefined,
        ...unresolvedConversationLines.map((line) => `  - ${line}`),
        `- Continue from the existing branch \`${task.worktree.branchName}\`.`,
        `- Fetch the latest \`${task.worktree.baseRef}\`, rebase onto it, resolve any conflicts, rerun the smallest useful verification, and push the updated branch.`,
        unresolvedConversationLines.length > 0
          ? "- Resolve each remaining review conversation on GitHub, or explicitly explain in a PR comment why a conversation should stay unresolved."
          : undefined,
        "- Keep the PR up to date and mention the PR URL in your final response."
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n\n")
    };
  }

  private buildMonitorRunMetadata(
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus,
    checks: GitHubPullRequestCheck[]
  ): Record<string, string> {
    const checkSummary = this.summarizeTaskPullRequestChecks(checks);

    return {
      trigger: "gh_pr_monitor",
      monitorPrNumber: String(pullRequest.number),
      monitorPrUrl: pullRequest.url,
      monitorPrHeadRef: pullRequest.headRef,
      monitorPrBaseRef: pullRequest.baseRef,
      monitorPrHeadSha: pullRequest.headSha ?? "",
      monitorPrBaseSha: pullRequest.baseSha ?? "",
      monitorPrMergeState: pullRequest.mergeStateStatus ?? "",
      monitorPrMergeable: pullRequest.mergeable ?? "",
      monitorPrCiStatus: ciStatus,
      monitorPrStatusCheckRollupState: pullRequest.statusCheckRollupState ?? "",
      monitorPrFeedbackCount: String(pullRequest.feedbackCount ?? 0),
      monitorPrFeedbackUpdatedAt: pullRequest.feedbackUpdatedAt ?? "",
      monitorPrUnresolvedConversationCount: String(
        pullRequest.unresolvedConversationCount ?? 0
      ),
      monitorPrUnresolvedConversationUpdatedAt:
        pullRequest.unresolvedConversationUpdatedAt ?? "",
      monitorPrUnresolvedConversationSignature:
        this.buildUnresolvedConversationSignature(pullRequest),
      monitorPrReviewDecision: pullRequest.reviewDecision ?? "",
      monitorPrRequiredChecksTotal: String(checkSummary?.total ?? 0),
      monitorPrRequiredChecksPassed: String(checkSummary?.passed ?? 0),
      monitorPrRequiredChecksFailed: String(checkSummary?.failed ?? 0),
      monitorPrRequiredChecksPending: String(checkSummary?.pending ?? 0)
    };
  }

  private buildTaskPullRequestSummary(
    pullRequest: GitHubPullRequestSummary,
    checks: GitHubPullRequestCheck[]
  ): TaskPullRequest {
    const summary: TaskPullRequest = {
      number: pullRequest.number,
      changedFiles: pullRequest.changedFiles,
      mergeable: pullRequest.mergeable,
      mergeStateStatus: pullRequest.mergeStateStatus,
      reviewDecision: pullRequest.reviewDecision,
      statusCheckRollupState: pullRequest.statusCheckRollupState,
      unresolvedConversationCount: pullRequest.unresolvedConversationCount,
      checks: this.summarizeTaskPullRequestChecks(checks),
      statusChecks: pullRequest.statusChecks,
      files: this.mapTaskPullRequestFiles(pullRequest.files)
    };

    if (pullRequest.title) {
      summary.title = pullRequest.title;
    }
    if (pullRequest.state) {
      summary.state = pullRequest.state;
    }
    if (pullRequest.isDraft !== undefined) {
      summary.isDraft = pullRequest.isDraft;
    }
    if (pullRequest.threadCount !== undefined) {
      summary.threadCount = pullRequest.threadCount;
    }
    if (pullRequest.reviewCount !== undefined) {
      summary.reviewCount = pullRequest.reviewCount;
    }
    if (pullRequest.approvalCount !== undefined) {
      summary.approvalCount = pullRequest.approvalCount;
    }
    if (pullRequest.changesRequestedCount !== undefined) {
      summary.changesRequestedCount = pullRequest.changesRequestedCount;
    }

    return summary;
  }

  private mapTaskPullRequestFiles(
    files?: GitHubPullRequestFile[]
  ): TaskPullRequestFile[] | undefined {
    if (!files?.length) {
      return undefined;
    }

    return files.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions
    }));
  }

  private summarizeTaskPullRequestChecks(
    checks: GitHubPullRequestCheck[]
  ): TaskPullRequestChecks | undefined {
    if (checks.length === 0) {
      return undefined;
    }

    let passed = 0;
    let failed = 0;
    let pending = 0;

    for (const check of checks) {
      if (check.bucket === "pass") {
        passed += 1;
        continue;
      }

      if (check.bucket === "fail" || check.bucket === "cancel") {
        failed += 1;
        continue;
      }

      if (check.bucket === "pending" || check.bucket === "skipping") {
        pending += 1;
      }
    }

    return {
      total: checks.length,
      passed,
      failed,
      pending
    };
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
      this.taskPullRequestSummaryEquals(task.pullRequest, nextPullRequest)
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

  private taskPullRequestSummaryEquals(
    left?: TaskPullRequest,
    right?: TaskPullRequest
  ): boolean {
    if (left === right) {
      return true;
    }

    return (
      left?.number === right?.number &&
      left?.title === right?.title &&
      left?.state === right?.state &&
      left?.isDraft === right?.isDraft &&
      left?.changedFiles === right?.changedFiles &&
      left?.mergeable === right?.mergeable &&
      left?.mergeStateStatus === right?.mergeStateStatus &&
      left?.reviewDecision === right?.reviewDecision &&
      left?.statusCheckRollupState === right?.statusCheckRollupState &&
      left?.threadCount === right?.threadCount &&
      left?.unresolvedConversationCount === right?.unresolvedConversationCount &&
      left?.reviewCount === right?.reviewCount &&
      left?.approvalCount === right?.approvalCount &&
      left?.changesRequestedCount === right?.changesRequestedCount &&
      this.taskPullRequestChecksEqual(left?.checks, right?.checks) &&
      this.taskPullRequestChecksEqual(left?.statusChecks, right?.statusChecks) &&
      this.taskPullRequestFilesEqual(left?.files, right?.files)
    );
  }

  private taskPullRequestChecksEqual(
    left?: TaskPullRequestChecks,
    right?: TaskPullRequestChecks
  ): boolean {
    if (left === right) {
      return true;
    }

    return (
      left?.total === right?.total &&
      left?.passed === right?.passed &&
      left?.failed === right?.failed &&
      left?.pending === right?.pending &&
      left?.skipped === right?.skipped
    );
  }

  private taskPullRequestFilesEqual(
    left?: TaskPullRequestFile[],
    right?: TaskPullRequestFile[]
  ): boolean {
    if (left === right) {
      return true;
    }

    if (!left || !right) {
      return left === right;
    }

    if (left.length !== right.length) {
      return false;
    }

    return left.every((file, index) => {
      const other = right[index];
      return (
        file.path === other?.path &&
        file.additions === other?.additions &&
        file.deletions === other?.deletions
      );
    });
  }

  private summarizeRequiredChecks(checks: { bucket: GitHubCheckBucket }[]): MonitorCiStatus {
    if (checks.length === 0) {
      return "not_required";
    }

    if (checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")) {
      return "fail";
    }
    if (checks.some((check) => check.bucket === "pending")) {
      return "pending";
    }
    if (checks.some((check) => check.bucket === "pass")) {
      return "pass";
    }
    if (checks.some((check) => check.bucket === "skipping")) {
      return "skipping";
    }

    return "not_required";
  }

  private hasFailingPullRequestCi(
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus
  ): boolean {
    if (ciStatus === "fail" || ciStatus === "cancel") {
      return true;
    }

    const rollupState = pullRequest.statusCheckRollupState?.toUpperCase();
    return (
      rollupState === "FAILURE" ||
      rollupState === "ERROR" ||
      rollupState === "CANCELLED" ||
      rollupState === "TIMED_OUT"
    );
  }

  private hasNewPullRequestFeedback(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary
  ): boolean {
    const feedbackUpdatedAt = pullRequest.feedbackUpdatedAt?.trim();
    const feedbackCount = pullRequest.feedbackCount ?? 0;
    if (!feedbackUpdatedAt || feedbackCount === 0) {
      return false;
    }

    if (!task.lastRunId) {
      return true;
    }

    const run = runsById.get(task.lastRunId);
    if (!run) {
      return true;
    }

    if (run.metadata?.trigger === "gh_pr_monitor") {
      return (
        run.metadata.monitorPrFeedbackCount !== String(feedbackCount) ||
        run.metadata.monitorPrFeedbackUpdatedAt !== feedbackUpdatedAt
      );
    }

    return this.didTimestampOccurAfter(run.endedAt ?? run.startedAt, feedbackUpdatedAt);
  }

  private hasUnresolvedPullRequestConversations(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary
  ): boolean {
    if ((pullRequest.unresolvedConversationCount ?? 0) === 0) {
      return false;
    }

    const unresolvedConversationSignature =
      this.buildUnresolvedConversationSignature(pullRequest);
    if (!unresolvedConversationSignature) {
      return false;
    }

    if (!task.lastRunId) {
      return true;
    }

    const run = runsById.get(task.lastRunId);
    if (!run) {
      return true;
    }

    if (run.metadata?.trigger !== "gh_pr_monitor") {
      return true;
    }

    return (
      run.metadata.monitorPrUnresolvedConversationSignature !==
      unresolvedConversationSignature
    );
  }

  private shouldCommentOnUnresolvedConversations(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary
  ): boolean {
    if ((pullRequest.unresolvedConversationCount ?? 0) === 0) {
      return false;
    }

    const unresolvedConversationSignature =
      this.buildUnresolvedConversationSignature(pullRequest);
    if (!unresolvedConversationSignature) {
      return false;
    }

    const run = task.lastRunId ? runsById.get(task.lastRunId) : undefined;
    return (
      run?.metadata?.monitorPrUnresolvedConversationSignature !==
      unresolvedConversationSignature
    );
  }

  private didTimestampOccurAfter(referenceTime?: string, candidateTime?: string): boolean {
    const referenceMs = referenceTime ? Date.parse(referenceTime) : Number.NaN;
    const candidateMs = candidateTime ? Date.parse(candidateTime) : Number.NaN;
    if (!Number.isFinite(candidateMs)) {
      return false;
    }
    if (!Number.isFinite(referenceMs)) {
      return true;
    }

    return candidateMs > referenceMs;
  }

  private joinMonitorReasonDescriptions(reasons: MonitorReason[]): string {
    const descriptions = reasons.map((reason) => reason.description);
    if (descriptions.length === 0) {
      return "the PR needs attention";
    }
    if (descriptions.length === 1) {
      return descriptions[0]!;
    }
    if (descriptions.length === 2) {
      return `${descriptions[0]} and ${descriptions[1]}`;
    }

    return `${descriptions.slice(0, -1).join(", ")}, and ${descriptions.at(-1)}`;
  }

  private formatMonitorFeedback(pullRequest: GitHubPullRequestSummary): string[] {
    return (pullRequest.feedbackItems ?? [])
      .slice(0, 5)
      .map((item) => {
        const author = item.author ? `@${item.author}` : "someone";
        const state = item.source === "review" && item.state ? ` (${item.state})` : "";
        const body = this.summarizeMonitorFeedbackBody(item.body);
        const when = item.updatedAt ?? item.createdAt;
        return `${author}${state}${when ? ` at ${when}` : ""}: ${body}`;
      });
  }

  private formatMonitorUnresolvedConversations(
    pullRequest: GitHubPullRequestSummary
  ): string[] {
    return (pullRequest.unresolvedConversationItems ?? [])
      .slice(0, 5)
      .map((item) => {
        const author = item.author ? `@${item.author}` : "someone";
        const location = item.path
          ? `${item.path}${item.line ? `:${item.line}` : ""}`
          : "the PR diff";
        const outdated = item.isOutdated ? " [outdated]" : "";
        const when = item.updatedAt ?? item.createdAt;
        return `${author}${when ? ` at ${when}` : ""} in ${location}${outdated}: ${this.summarizeMonitorFeedbackBody(item.body)}`;
      });
  }

  private buildUnresolvedConversationSignature(
    pullRequest: GitHubPullRequestSummary
  ): string {
    const ids = (pullRequest.unresolvedConversationItems ?? [])
      .map((item) => item.id.trim())
      .filter((value) => value.length > 0)
      .sort();
    if (ids.length === 0) {
      return "";
    }

    return [
      String(pullRequest.unresolvedConversationCount ?? ids.length),
      pullRequest.unresolvedConversationUpdatedAt ?? "",
      ids.join(",")
    ].join("|");
  }

  private async postUnresolvedConversationComment(
    repositoryFullName: string,
    task: Task,
    pullRequest: GitHubPullRequestSummary
  ): Promise<void> {
    const count = pullRequest.unresolvedConversationCount ?? 0;
    if (count === 0) {
      return;
    }

    const conversationLabel = count === 1 ? "conversation" : "conversations";
    const summaryLines = this.formatMonitorUnresolvedConversations(pullRequest)
      .slice(0, 3)
      .map((line) => `- ${line}`);
    const body = [
      `Detected ${count} unresolved review ${conversationLabel} while this PR was in review, so I'm moving task \`${task.title}\` back to running to address them.`,
      summaryLines.length > 0 ? summaryLines.join("\n") : undefined,
      "If you want me to leave any of these conversations unresolved instead of changing the code, reply here and say which ones should stay open."
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");

    try {
      await this.githubPullRequests.addPullRequestComment(
        repositoryFullName,
        pullRequest.number,
        body
      );
    } catch {
      // Best effort: the task should still resume even if the PR comment fails.
    }
  }

  private summarizeMonitorFeedbackBody(body?: string): string {
    const normalized = body?.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "No text included.";
    }

    if (normalized.length <= 160) {
      return normalized;
    }

    return `${normalized.slice(0, 157)}...`;
  }

  private baseRefMatches(baseRef: string, branchName: string): boolean {
    const trimmed = baseRef.trim();
    return trimmed === branchName || trimmed.endsWith(`/${branchName}`);
  }

  private quoteShell(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }

  private extractRemoteName(baseRef: string): string {
    const trimmed = baseRef.trim();
    if (!trimmed.includes("/")) {
      return "origin";
    }

    const [remoteName] = trimmed.split("/", 1);
    return remoteName || "origin";
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
    const runEntry = ensure(
      currentRuns.find((entry) => entry.id === runId),
      404,
      "RUN_NOT_FOUND",
      "Run not found"
    );
    const taskEntry = ensure(
      currentTasks.find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );

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

    taskEntry.column = "review";
    taskEntry.order = this.topOrder("review", taskId);
    taskEntry.pullRequestUrl = this.resolveTaskPullRequestUrl(taskEntry, runEntry);
    taskEntry.pullRequest = this.resolveTaskPullRequestSummary(taskEntry, runEntry);
    taskEntry.updatedAt = new Date().toISOString();

    this.store.setRuns(currentRuns);
    this.store.setTasks(currentTasks);
    await this.store.save();
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

    return {
      run: runEntry,
      task: taskEntry
    };
  }

  private resolveTaskPullRequestUrl(task: Task, run: Run): string | undefined {
    const latestPullRequestUrl = run.metadata?.prUrl?.trim();
    if (latestPullRequestUrl) {
      return latestPullRequestUrl;
    }

    const monitoredPullRequestUrl = run.metadata?.monitorPrUrl?.trim();
    if (monitoredPullRequestUrl) {
      return monitoredPullRequestUrl;
    }

    const existingPullRequestUrl = task.pullRequestUrl?.trim();
    return existingPullRequestUrl || undefined;
  }

  private resolveTaskPullRequestSummary(task: Task, run: Run): TaskPullRequest | undefined {
    const metadata = run.metadata;
    if (!metadata) {
      return task.pullRequest;
    }

    const number = toOptionalNumber(metadata.monitorPrNumber);
    const checksTotal = toOptionalNumber(metadata.monitorPrRequiredChecksTotal);
    const checksPassed = toOptionalNumber(metadata.monitorPrRequiredChecksPassed);
    const checksFailed = toOptionalNumber(metadata.monitorPrRequiredChecksFailed);
    const checksPending = toOptionalNumber(metadata.monitorPrRequiredChecksPending);
    const unresolvedConversationCount = toOptionalNumber(
      metadata.monitorPrUnresolvedConversationCount
    );
    const hasMonitorData =
      number !== undefined ||
      Boolean(metadata.monitorPrMergeable) ||
      Boolean(metadata.monitorPrMergeState) ||
      Boolean(metadata.monitorPrStatusCheckRollupState) ||
      Boolean(metadata.monitorPrReviewDecision) ||
      unresolvedConversationCount !== undefined ||
      checksTotal !== undefined;

    if (!hasMonitorData) {
      return task.pullRequest;
    }

    const checks =
      checksTotal !== undefined && checksTotal > 0
        ? {
            total: checksTotal,
            passed: checksPassed ?? 0,
            failed: checksFailed ?? 0,
            pending: checksPending ?? 0
          }
        : undefined;

    const summary: TaskPullRequest = {
      number,
      mergeable: metadata.monitorPrMergeable || undefined,
      mergeStateStatus: metadata.monitorPrMergeState || undefined,
      reviewDecision: metadata.monitorPrReviewDecision || undefined,
      statusCheckRollupState: metadata.monitorPrStatusCheckRollupState || undefined,
      unresolvedConversationCount,
      checks
    };

    if (task.pullRequest?.title) {
      summary.title = task.pullRequest.title;
    }
    if (task.pullRequest?.state) {
      summary.state = task.pullRequest.state;
    }
    if (task.pullRequest?.isDraft !== undefined) {
      summary.isDraft = task.pullRequest.isDraft;
    }
    if (task.pullRequest?.changedFiles !== undefined) {
      summary.changedFiles = task.pullRequest.changedFiles;
    }
    if (task.pullRequest?.threadCount !== undefined) {
      summary.threadCount = task.pullRequest.threadCount;
    }
    if (task.pullRequest?.reviewCount !== undefined) {
      summary.reviewCount = task.pullRequest.reviewCount;
    }
    if (task.pullRequest?.approvalCount !== undefined) {
      summary.approvalCount = task.pullRequest.approvalCount;
    }
    if (task.pullRequest?.changesRequestedCount !== undefined) {
      summary.changesRequestedCount = task.pullRequest.changesRequestedCount;
    }
    if (task.pullRequest?.files) {
      summary.files = task.pullRequest.files;
    }
    if (task.pullRequest?.statusChecks) {
      summary.statusChecks = task.pullRequest.statusChecks;
    }

    return summary;
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
