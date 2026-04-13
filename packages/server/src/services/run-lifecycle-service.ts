import type {
  Run,
  RunLogEntry,
  RunnerConfig,
  Task,
  Workspace
} from "@workhorse/contracts";

import { AppError, ensure } from "../lib/errors.js";
import { createId } from "../lib/id.js";
import { createRunLogEntry } from "../lib/run-log.js";
import {
  buildContinuationRun,
  canContinueCodexRun,
  cloneRun,
  resolveContinuationCandidateRunId
} from "../runners/codex-continuation.js";
import type { RunnerAdapter, RunnerControl } from "../runners/types.js";
import type { StateStore } from "../persistence/state-store.js";
import type { EventBus } from "../ws/event-bus.js";
import type { GitWorktreeService } from "./git-worktree-service.js";
import type { CodexAppServer } from "../runners/codex-app-server-manager.js";
import type { AiReviewService } from "./ai-review-service.js";
import {
  resolveTaskPullRequestSummary,
  resolveTaskPullRequestUrl
} from "./pull-request-snapshot.js";

export interface ActiveRun {
  control: RunnerControl;
  stopRequested: boolean;
  runId: string;
  runnerType: Task["runnerType"];
  queue(work: () => Promise<void>): Promise<void>;
}

export interface StartTaskOptions {
  allowedColumns?: Task["column"][];
  runnerConfigOverride?: RunnerConfig;
  runMetadata?: Record<string, string>;
  initialInputText?: string;
  targetOrder?: number;
  targetColumn?: Task["column"];
  skipDependencyCheck?: boolean;
}

export interface RunLifecycleDependencies {
  store: StateStore;
  events: EventBus;
  runners(): Record<string, RunnerAdapter>;
  gitWorktrees(): GitWorktreeService;
  codexAppServer: CodexAppServer;
  aiReview: AiReviewService;
  requireTask(taskId: string, source?: Task[]): Task;
  requireWorkspace(workspaceId: string): Workspace;
  requireRun(runId: string, source?: Run[]): Run;
  topOrder(column: Task["column"], excludingTaskId?: string): number;
  canTaskStart(task: Task, source?: Task[]): boolean;
  evaluateScheduler(): Promise<void>;
  afterRunFinished?(task: Task, run: Run): Promise<void>;
}

export class RunLifecycleService {
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly deps: RunLifecycleDependencies) {}

  public isActive(taskId: string): boolean {
    return this.activeRuns.has(taskId);
  }

  public getActiveRunId(taskId: string): string | undefined {
    return this.activeRuns.get(taskId)?.runId;
  }

  public activeCount(): number {
    return this.activeRuns.size;
  }

  public activeCountByRunner(type: Task["runnerType"]): number {
    return [...this.activeRuns.values()].filter((entry) => entry.runnerType === type)
      .length;
  }

  public async recoverOrphanedRuns(): Promise<void> {
    const runs = this.deps.store.listRuns();
    for (const run of runs) {
      if (run.status !== "queued" && run.status !== "running") {
        continue;
      }

      await this.transitionTaskRunToReview(run.taskId, run.id, {
        status: this.resolveOrphanedRunStatus(run)
      });
    }
  }

  public async startTask(
    taskId: string,
    options: StartTaskOptions = {}
  ): Promise<{ task: Task; run: Run }> {
    if (this.activeRuns.has(taskId)) {
      throw new AppError(409, "TASK_ALREADY_RUNNING", "Task already has an active run");
    }

    const tasks = this.deps.store.listTasks();
    const task = this.deps.requireTask(taskId, tasks);
    this.ensureStartableTask(task, options.allowedColumns);
    if (!options.skipDependencyCheck && !this.deps.canTaskStart(task, tasks)) {
      throw new AppError(
        409,
        "DEPENDENCIES_NOT_MET",
        "Task dependencies are not satisfied"
      );
    }
    const workspace = this.deps.requireWorkspace(task.workspaceId);
    let executionWorkspace = workspace;

    if (workspace.isGitRepo) {
      task.worktree = await this.deps.gitWorktrees().ensureTaskWorktree(workspace, task);
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
    const currentRuns = this.deps.store.listRuns();
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
      ? buildContinuationRun(reusableRunEntry, (id) => this.deps.store.createLogPath(id), options.runMetadata)
      : (() => {
          const runId = createId();
          return {
            id: runId,
            taskId: task.id,
            status: "queued",
            runnerType: executionTask.runnerType,
            command: "",
            startedAt: new Date().toISOString(),
            logFile: this.deps.store.createLogPath(runId),
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
      order: options.targetOrder ?? this.deps.topOrder(targetColumn, task.id),
      lastRunId: run.id,
      lastRunStatus: "queued",
      rejected: false,
      continuationRunId:
        executionTask.runnerType === "codex" ? run.id : task.continuationRunId,
      updatedAt: new Date().toISOString()
    };

    this.deps.store.setRuns(runs);
    this.deps.store.setTasks(tasks);
    await this.deps.store.save();
    this.deps.events.publish({
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

    const runner = this.deps.runners()[executionTask.runnerType];
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
            logFile: this.deps.store.createLogPath(run.id)
          },
          previousRun,
          task: executionTask,
          workspace: executionWorkspace,
          inputText: options.initialInputText,
          resumeSessionId: options.runMetadata?.resumeSessionId
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
      run.logFile = this.deps.store.createLogPath(run.id);
      run.metadata = {
        ...(run.metadata ?? {}),
        ...(control.metadata ?? {})
      };
      this.deps.store.setRuns(runs);
      await this.deps.store.save();

      this.activeRuns.set(task.id, {
        control,
        stopRequested: false,
        runId: run.id,
        runnerType: executionTask.runnerType,
        queue: queueOutput
      });

      this.deps.events.publish({
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
        order: this.deps.topOrder("review", task.id),
        updatedAt: new Date().toISOString()
      };
      this.deps.store.setRuns(runs);
      this.deps.store.setTasks(tasks);
      await this.deps.store.save();
      this.deps.events.publish({
        type: "task.updated",
        action: "updated",
        taskId: tasks[taskIndex].id,
        task: tasks[taskIndex]
      });
      this.deps.events.publish({
        type: "run.finished",
        taskId: tasks[taskIndex].id,
        run,
        task: tasks[taskIndex]
      });
      await this.deps.evaluateScheduler();
      throw error;
    }
  }

  public async stopRun(taskId: string): Promise<{ task: Task; run: Run }> {
    const active = this.activeRuns.get(taskId);
    if (!active) {
      throw new AppError(400, "TASK_NOT_RUNNING", "Task does not have an active run");
    }

    const run = ensure(
      this.deps.store
        .listRuns()
        .find((entry) => entry.taskId === taskId && entry.status === "running"),
      404,
      "RUN_NOT_FOUND",
      "Run not found"
    );
    const task = this.deps.requireTask(taskId);

    active.stopRequested = true;
    await active.control.stop();
    return { task, run };
  }

  public async sendInput(
    taskId: string,
    input: { text: string }
  ): Promise<{ task: Task; run: Run }> {
    const text = input.text.trim();
    if (!text) {
      throw new AppError(400, "INVALID_TASK_INPUT", "Task input cannot be blank");
    }

    const task = this.deps.requireTask(taskId);

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

      return this.startTask(taskId, {
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

    const run = this.deps.requireRun(active.runId);

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

    const updatedTask = this.deps.requireTask(taskId);
    const updatedRun = this.deps.requireRun(run.id);

    return {
      task: updatedTask,
      run: updatedRun
    };
  }

  public async archiveTaskCodexThread(task: Task): Promise<void> {
    const runId = task.continuationRunId ?? task.lastRunId;
    if (this.activeRuns.has(task.id) || !runId) {
      return;
    }

    const run = this.deps.store.listRuns().find((entry) => entry.id === runId);
    const threadId =
      run?.runnerType === "codex"
        ? run.metadata?.threadId?.trim()
        : undefined;
    if (!threadId) {
      return;
    }

    try {
      await this.deps.codexAppServer.archiveThread(threadId);
    } catch {
      // Archiving the remote thread is best-effort and should not block task completion.
    }
  }

  public async appendAndPublishRunOutput(
    taskId: string,
    runId: string,
    entry: RunLogEntry
  ): Promise<void> {
    await this.deps.store.appendLogEntry(runId, entry);
    this.deps.events.publish({
      type: "run.output",
      taskId,
      runId,
      entry
    });
  }

  public async updateRunMetadata(
    runId: string,
    metadata: Record<string, string>
  ): Promise<Run> {
    const runs = this.deps.store.listRuns();
    const run = this.deps.requireRun(runId, runs);

    run.metadata = {
      ...(run.metadata ?? {}),
      ...metadata
    };

    this.deps.store.setRuns(runs);
    await this.deps.store.save();
    return run;
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
    const currentRuns = this.deps.store.listRuns();
    const currentTasks = this.deps.store.listTasks();
    const runEntry = this.deps.requireRun(runId, currentRuns);
    const taskEntry = this.deps.requireTask(taskId, currentTasks);

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

    const isPlanRun = runEntry.metadata?.trigger === "plan_generation";

    if (isPlanRun) {
      if (result.status === "succeeded") {
        const planText = await this.extractPlanText(runEntry.id);
        if (planText) {
          taskEntry.plan = planText;
        }
      }
      taskEntry.column = "todo";
      taskEntry.order = this.deps.topOrder("todo", taskId);
      taskEntry.lastRunStatus = result.status;
      taskEntry.updatedAt = new Date().toISOString();

      this.deps.store.setRuns(currentRuns);
      this.deps.store.setTasks(currentTasks);
      await this.deps.store.save();
      this.deps.events.publish({
        type: "task.updated",
        action: "updated",
        taskId: taskEntry.id,
        task: taskEntry
      });
      this.deps.events.publish({
        type: "run.finished",
        taskId: taskEntry.id,
        run: runEntry,
        task: taskEntry
      });
      await this.deps.afterRunFinished?.(taskEntry, runEntry);
      return { run: runEntry, task: taskEntry };
    }

    const shouldAutoReview = this.deps.aiReview.shouldAutoTriggerAiReview(taskEntry, runEntry, result.status);
    const isAiReviewRun = this.deps.aiReview.isAiReviewTrigger(runEntry.metadata?.trigger);
    const shouldRework =
      isAiReviewRun &&
      result.status === "succeeded" &&
      runEntry.metadata?.reviewVerdict === "request_changes";
    const nextColumn: Task["column"] =
      shouldAutoReview || shouldRework ? "running" : "review";

    taskEntry.column = nextColumn;
    taskEntry.order = this.deps.topOrder(nextColumn, taskId);
    taskEntry.lastRunStatus = result.status;
    taskEntry.rejected = false;
    taskEntry.pullRequestUrl = resolveTaskPullRequestUrl(taskEntry, runEntry);
    taskEntry.pullRequest = resolveTaskPullRequestSummary(taskEntry, runEntry);
    taskEntry.updatedAt = new Date().toISOString();

    this.deps.store.setRuns(currentRuns);
    this.deps.store.setTasks(currentTasks);
    await this.deps.store.save();
    if (isAiReviewRun) {
      await this.deps.aiReview.maybePublishManualReviewToPullRequest(taskEntry, runEntry);
    }
    this.deps.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: taskEntry.id,
      task: taskEntry
    });

    this.deps.events.publish({
      type: "run.finished",
      taskId: taskEntry.id,
      run: runEntry,
      task: taskEntry
    });

    if (shouldAutoReview) {
      await this.deps.aiReview.triggerAiReview(taskEntry);
    }

    if (shouldRework) {
      await this.deps.aiReview.triggerReworkFromReview(taskEntry, runEntry);
    }

    await this.deps.evaluateScheduler();
    await this.deps.afterRunFinished?.(taskEntry, runEntry);

    return {
      run: runEntry,
      task: taskEntry
    };
  }

  private createUserInputLogEntry(runId: string, text: string): RunLogEntry {
    return createRunLogEntry(runId, {
      kind: "user",
      stream: "system",
      title: "User input",
      text
    });
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

  private async extractPlanText(runId: string): Promise<string | undefined> {
    const entries = await this.deps.store.readLogEntries(runId);
    const agentEntries = entries.filter((entry) => entry.kind === "agent");
    const lastAgent = agentEntries.at(-1);
    return lastAgent?.text.trim() || undefined;
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
