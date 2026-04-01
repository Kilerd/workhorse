import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import type {
  AppState,
  CreateTaskBody,
  CreateWorkspaceBody,
  DeleteResult,
  ListTasksQuery,
  Run,
  RunnerConfig,
  Task,
  TaskWorktree,
  UpdateTaskBody,
  UpdateWorkspaceBody,
  WorkspaceGitRef,
  Workspace
} from "@workhorse/contracts";

import { AppError, ensure } from "../lib/errors.js";
import {
  GhCliPullRequestProvider,
  type GitHubCheckBucket,
  type GitHubPullRequestProvider,
  type GitHubPullRequestSummary
} from "../lib/github.js";
import { createId } from "../lib/id.js";
import { createRunLogEntry } from "../lib/run-log.js";
import { createTaskWorktree } from "../lib/task-worktree.js";
import { StateStore } from "../persistence/state-store.js";
import { CodexAcpRunner } from "../runners/codex-acp-runner.js";
import type { RunnerAdapter, RunnerControl } from "../runners/types.js";
import { ShellRunner } from "../runners/shell-runner.js";
import { EventBus } from "../ws/event-bus.js";
import { GitWorktreeService } from "./git-worktree-service.js";

interface ActiveRun {
  control: RunnerControl;
  stopRequested: boolean;
}

interface StartTaskOptions {
  allowedColumns?: Task["column"][];
  runnerConfigOverride?: RunnerConfig;
  runMetadata?: Record<string, string>;
}

type MonitorCiStatus = GitHubCheckBucket | "not_required";

interface BoardServiceDependencies {
  gitWorktrees?: GitWorktreeService;
  githubPullRequests?: GitHubPullRequestProvider;
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

export class BoardService {
  private readonly store: StateStore;

  private readonly events: EventBus;

  private readonly runners: Record<string, RunnerAdapter>;

  private readonly gitWorktrees: GitWorktreeService;

  private readonly githubPullRequests: GitHubPullRequestProvider;

  private readonly activeRuns = new Map<string, ActiveRun>();

  private reviewMonitorLastPolledAt?: string;

  public constructor(
    store: StateStore,
    events: EventBus,
    dependencies: BoardServiceDependencies = {}
  ) {
    this.store = store;
    this.events = events;
    this.runners = {
      shell: new ShellRunner(),
      codex: new CodexAcpRunner()
    };
    this.gitWorktrees = dependencies.gitWorktrees ?? new GitWorktreeService();
    this.githubPullRequests =
      dependencies.githubPullRequests ?? new GhCliPullRequestProvider();
  }

  public async initialize(): Promise<void> {
    await this.store.load();
    await this.recoverOrphanedRuns();
  }

  public snapshot(): AppState {
    return this.store.snapshot();
  }

  public getReviewMonitorLastPolledAt(): string | undefined {
    return this.reviewMonitorLastPolledAt;
  }

  public listWorkspaces(): Workspace[] {
    return this.store
      .listWorkspaces()
      .sort((left, right) => left.name.localeCompare(right.name));
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

    if (!input.title.trim()) {
      throw new AppError(400, "INVALID_TASK", "Task title is required");
    }
    this.ensureRunnerConfig(input.runnerType, input.runnerConfig);
    const taskId = createId();
    const worktree = workspace.isGitRepo
      ? createTaskWorktree(taskId, input.title, {
          workspace,
          baseRef: await this.gitWorktrees.resolveBaseRef(
            workspace,
            input.worktreeBaseRef
          )
        })
      : createTaskWorktree(taskId, input.title, {
          workspace
        });

    const now = new Date().toISOString();
    const column = input.column ?? "backlog";
    const task: Task = {
      id: taskId,
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
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
            const mergedPr = await this.githubPullRequests.findMergedPullRequest(
              repositoryFullName,
              task.worktree.branchName
            );
            if (mergedPr && this.baseRefMatches(task.worktree.baseRef, mergedPr.baseRef)) {
              await this.updateTask(task.id, {
                column: "done"
              });
            }
            continue;
          }

          const checks = await this.githubPullRequests.listRequiredChecks(
            repositoryFullName,
            openPr.number
          );
          const ciStatus = this.summarizeRequiredChecks(checks);
          if (!this.shouldAutoResumePullRequest(task, openPr)) {
            continue;
          }
          if (this.wasMonitorRunAlreadyAttempted(task, runsById, openPr)) {
            continue;
          }

          await this.startTaskInternal(task.id, {
            allowedColumns: ["review"],
            runnerConfigOverride: this.buildMonitorRunnerConfig(task, openPr, ciStatus),
            runMetadata: this.buildMonitorRunMetadata(openPr, ciStatus)
          });
          resumedTaskIds.push(task.id);
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
    task.order = this.nextOrder("todo");
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
    const previousRun =
      task.lastRunId !== undefined
        ? this.store.listRuns().find((entry) => entry.id === task.lastRunId)
        : undefined;

    const runId = createId();
    const run: Run = {
      id: runId,
      taskId: task.id,
      status: "queued",
      runnerType: executionTask.runnerType,
      command: "",
      startedAt: new Date().toISOString(),
      logFile: this.store.createLogPath(runId),
      metadata: options.runMetadata
    };

    const runs = [...this.store.listRuns(), run];
    const taskIndex = tasks.findIndex((entry) => entry.id === task.id);
    tasks[taskIndex] = {
      ...task,
      column: "running",
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
          workspace: executionWorkspace
        },
        {
          onOutput: async (output) => {
            await queueOutput(async () => {
              const entry = createRunLogEntry(run.id, output);
              await this.store.appendLogEntry(run.id, entry);
              this.events.publish({
                type: "run.output",
                taskId: task.id,
                runId: run.id,
                entry
              });
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
        stopRequested: false
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
      await this.store.appendLogEntry(run.id, entry);
      this.events.publish({
        type: "run.output",
        taskId: task.id,
        runId: run.id,
        entry
      });
      tasks[taskIndex] = {
        ...tasks[taskIndex],
        column: "review",
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

  private shouldAutoResumePullRequest(
    task: Task,
    pullRequest: GitHubPullRequestSummary
  ): boolean {
    if (!this.baseRefMatches(task.worktree.baseRef, pullRequest.baseRef)) {
      return false;
    }

    const mergeable = pullRequest.mergeable?.toUpperCase();
    const mergeStateStatus = pullRequest.mergeStateStatus?.toUpperCase();
    return (
      mergeable === "CONFLICTING" ||
      mergeStateStatus === "DIRTY" ||
      mergeStateStatus === "BEHIND"
    );
  }

  private wasMonitorRunAlreadyAttempted(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary
  ): boolean {
    if (!task.lastRunId) {
      return false;
    }

    const run = runsById.get(task.lastRunId);
    if (!run?.metadata || run.metadata.trigger !== "gh_pr_monitor") {
      return false;
    }

    return (
      run.metadata.monitorPrNumber === String(pullRequest.number) &&
      run.metadata.monitorPrHeadSha === (pullRequest.headSha ?? "") &&
      run.metadata.monitorPrBaseSha === (pullRequest.baseSha ?? "") &&
      run.metadata.monitorPrMergeState === (pullRequest.mergeStateStatus ?? "")
    );
  }

  private buildMonitorRunnerConfig(
    task: Task,
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus
  ): RunnerConfig {
    const reason = this.describeMonitorReason(pullRequest);

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

    return {
      ...task.runnerConfig,
      prompt: [
        task.runnerConfig.prompt.trim(),
        "GitHub PR monitor update:",
        `- PR #${pullRequest.number} (${pullRequest.url}) is ${reason}.`,
        `- Required CI status is currently \`${ciStatus}\`.`,
        `- Continue from the existing branch \`${task.worktree.branchName}\`.`,
        `- Fetch the latest \`${task.worktree.baseRef}\`, rebase onto it, resolve any conflicts, rerun the smallest useful verification, and push the updated branch.`,
        "- Keep the PR up to date and mention the PR URL in your final response."
      ].join("\n\n")
    };
  }

  private buildMonitorRunMetadata(
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus
  ): Record<string, string> {
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
      monitorPrCiStatus: ciStatus
    };
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

  private describeMonitorReason(pullRequest: GitHubPullRequestSummary): string {
    const mergeable = pullRequest.mergeable?.toUpperCase();
    const mergeStateStatus = pullRequest.mergeStateStatus?.toUpperCase();
    if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
      return "currently conflicting with its base branch";
    }
    if (mergeStateStatus === "BEHIND") {
      return "behind its base branch";
    }

    return "no longer cleanly mergeable";
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

    taskEntry.column = "review";
    taskEntry.pullRequestUrl = this.resolveTaskPullRequestUrl(taskEntry, runEntry);
    taskEntry.updatedAt = new Date().toISOString();

    this.store.setRuns(currentRuns);
    this.store.setTasks(currentTasks);
    await this.store.save();
    this.activeRuns.delete(taskId);
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
