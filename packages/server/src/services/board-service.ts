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
  UpdateTaskBody,
  UpdateWorkspaceBody,
  Workspace
} from "@workhorse/contracts";

import { AppError, ensure } from "../lib/errors.js";
import { createId } from "../lib/id.js";
import { StateStore } from "../persistence/state-store.js";
import { CodexAcpRunner } from "../runners/codex-acp-runner.js";
import type { RunnerAdapter, RunnerControl } from "../runners/types.js";
import { ShellRunner } from "../runners/shell-runner.js";
import { EventBus } from "../ws/event-bus.js";

interface ActiveRun {
  control: RunnerControl;
  stopRequested: boolean;
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

  private readonly activeRuns = new Map<string, ActiveRun>();

  public constructor(store: StateStore, events: EventBus) {
    this.store = store;
    this.events = events;
    this.runners = {
      shell: new ShellRunner(),
      codex: new CodexAcpRunner()
    };
  }

  public async initialize(): Promise<void> {
    await this.store.load();
    await this.recoverOrphanedRuns();
  }

  public snapshot(): AppState {
    return this.store.snapshot();
  }

  public listWorkspaces(): Workspace[] {
    return this.store
      .listWorkspaces()
      .sort((left, right) => left.name.localeCompare(right.name));
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

    const now = new Date().toISOString();
    const column = input.column ?? "backlog";
    const task: Task = {
      id: createId(),
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      workspaceId: workspace.id,
      column,
      order: input.order ?? this.nextOrder(column),
      runnerType: input.runnerType,
      runnerConfig: input.runnerConfig,
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

    if (input.workspaceId) {
      ensure(
        this.store.listWorkspaces().find((entry) => entry.id === input.workspaceId),
        404,
        "WORKSPACE_NOT_FOUND",
        "Workspace not found"
      );
      task.workspaceId = input.workspaceId;
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
    task.description = input.description?.trim() ?? task.description;
    task.column = input.column ?? task.column;
    task.order = input.order ?? task.order;
    task.runnerType = input.runnerType ?? task.runnerType;
    task.runnerConfig = input.runnerConfig ?? task.runnerConfig;
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
    if (this.activeRuns.has(taskId)) {
      throw new AppError(409, "TASK_ALREADY_RUNNING", "Task already has an active run");
    }

    const task = ensure(
      this.store.listTasks().find((entry) => entry.id === taskId),
      404,
      "TASK_NOT_FOUND",
      "Task not found"
    );
    this.ensureStartableTask(task);
    const workspace = ensure(
      this.store.listWorkspaces().find((entry) => entry.id === task.workspaceId),
      404,
      "WORKSPACE_NOT_FOUND",
      "Workspace not found"
    );

    const runId = createId();
    const run: Run = {
      id: runId,
      taskId: task.id,
      status: "queued",
      runnerType: task.runnerType,
      command: "",
      startedAt: new Date().toISOString(),
      logFile: this.store.createLogPath(runId)
    };

    const runs = [...this.store.listRuns(), run];
    const tasks = this.store.listTasks();
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

    const runner = this.runners[task.runnerType];
    if (!runner) {
      throw new AppError(
        400,
        "RUNNER_NOT_SUPPORTED",
        `No runner available for ${task.runnerType}`
      );
    }

    try {
      const control = await runner.start(
        {
          run: {
            ...run,
            logFile: this.store.createLogPath(run.id)
          },
          task,
          workspace
        },
        {
          onOutput: async (chunk, stream) => {
            await this.store.appendLog(run.id, chunk);
            this.events.publish({
              type: "run.output",
              taskId: task.id,
              runId: run.id,
              chunk,
              stream,
              timestamp: new Date().toISOString()
            });
          },
          onExit: async (result) => {
            const currentRuns = this.store.listRuns();
            const currentTasks = this.store.listTasks();
            const runEntry = ensure(
              currentRuns.find((entry) => entry.id === run.id),
              404,
              "RUN_NOT_FOUND",
              "Run not found"
            );
            const taskEntry = ensure(
              currentTasks.find((entry) => entry.id === task.id),
              404,
              "TASK_NOT_FOUND",
              "Task not found"
            );

            runEntry.status = this.activeRuns.get(task.id)?.stopRequested
              ? "canceled"
              : result.status;
            runEntry.exitCode = result.exitCode;
            runEntry.endedAt = new Date().toISOString();
            runEntry.metadata = result.metadata;

            taskEntry.column = "review";
            taskEntry.updatedAt = new Date().toISOString();

            this.store.setRuns(currentRuns);
            this.store.setTasks(currentTasks);
            await this.store.save();
            this.activeRuns.delete(task.id);
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
          }
        }
      );

      run.status = "running";
      run.command = control.command;
      run.pid = control.pid;
      run.logFile = this.store.createLogPath(run.id);
      run.metadata = control.metadata;
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
      await this.store.appendLog(run.id, `${error instanceof Error ? error.message : String(error)}\n`);
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

  public async getRunLog(runId: string): Promise<string> {
    const run = this.store.listRuns().find((entry) => entry.id === runId);
    if (!run) {
      throw new AppError(404, "RUN_NOT_FOUND", "Run not found");
    }

    return this.store.readLog(runId);
  }

  private async recoverOrphanedRuns(): Promise<void> {
    const runs = this.store.listRuns();
    const tasks = this.store.listTasks();
    let changed = false;

    for (const run of runs) {
      if (run.status !== "queued" && run.status !== "running") {
        continue;
      }

      run.status = "canceled";
      run.endedAt = new Date().toISOString();
      changed = true;

      const task = tasks.find((entry) => entry.id === run.taskId);
      if (task) {
        task.column = "review";
        task.updatedAt = new Date().toISOString();
      }
    }

    if (changed) {
      this.store.setRuns(runs);
      this.store.setTasks(tasks);
      await this.store.save();
    }
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

  private ensureStartableTask(task: Task): void {
    if (task.column === "backlog" || task.column === "todo") {
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
}
