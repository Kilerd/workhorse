import type { Task, TaskColumn, Thread } from "@workhorse/contracts";

import { AppError, ensure } from "../lib/errors.js";
import { createId } from "../lib/id.js";
import { createTaskWorktree } from "../lib/task-worktree.js";
import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";
import { ThreadService } from "./thread-service.js";

export type TaskActor = "user" | "system";

export interface CreateTaskInput {
  workspaceId: string;
  title: string;
  description?: string;
  source?: Task["source"];
  planId?: string;
  assigneeAgentId?: string;
  dependencies?: string[];
  column?: Extract<TaskColumn, "backlog" | "todo">;
}

export interface ListTasksFilter {
  column?: TaskColumn;
  source?: Task["source"];
  planId?: string;
}

export type RunFinishOutcome = "succeeded" | "failed" | "interrupted";

// Transitions the user can initiate from the kanban UI. The agent-driven
// board deliberately restricts direct access to running/review — those
// transitions only happen as a side effect of run lifecycle events.
const USER_ALLOWED: ReadonlySet<`${TaskColumn}->${TaskColumn}`> = new Set([
  "backlog->todo",
  "backlog->archived",
  "todo->backlog",
  "todo->archived",
  "blocked->todo",
  "blocked->archived",
  "done->archived",
  // Review → done is a user action, but goes through approveReview/rejectReview
  // so we intentionally omit it from the plain drag-and-drop set.
]);

// System transitions cover the full state machine (PRD §3.2).
const SYSTEM_ALLOWED: ReadonlySet<`${TaskColumn}->${TaskColumn}`> = new Set([
  "backlog->todo",
  "backlog->archived",
  "todo->blocked",
  "todo->running",
  "todo->backlog",
  "todo->archived",
  "blocked->todo",
  "blocked->archived",
  "running->review",
  "running->todo",
  "review->done",
  "done->archived"
]);

export class TaskService {
  public constructor(
    private readonly store: StateStore,
    private readonly threads: ThreadService,
    private readonly events: EventBus
  ) {}

  // ── Queries ───────────────────────────────────────────────────────────────

  public getTask(id: string): Task | undefined {
    return this.store.listTasks().find((t) => t.id === id);
  }

  public requireTask(id: string): Task {
    return ensure(
      this.getTask(id),
      404,
      "TASK_NOT_FOUND",
      `Task ${id} not found`
    );
  }

  public listTasks(workspaceId: string, filter: ListTasksFilter = {}): Task[] {
    return this.store
      .listTasks()
      .filter((task) => {
        if (task.workspaceId !== workspaceId) return false;
        if (filter.column && task.column !== filter.column) return false;
        if (filter.source && task.source !== filter.source) return false;
        if (filter.planId && task.planId !== filter.planId) return false;
        return true;
      });
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  public async createTask(input: CreateTaskInput): Promise<{ task: Task; thread: Thread }> {
    const now = new Date().toISOString();
    const id = createId();
    const source: Task["source"] = input.source ?? "user";
    const workspaces = this.store.listWorkspaces();
    const workspace = workspaces.find((w) => w.id === input.workspaceId);
    if (!workspace) {
      throw new AppError(
        404,
        "WORKSPACE_NOT_FOUND",
        `Workspace ${input.workspaceId} not found`
      );
    }

    const task: Task = {
      id,
      title: input.title,
      description: input.description ?? "",
      workspaceId: input.workspaceId,
      column: input.column ?? "todo",
      order: Date.now(),
      dependencies: input.dependencies ?? [],
      worktree: createTaskWorktree(id, input.title, { workspace }),
      taskKind: "user",
      source,
      planId: input.planId,
      assigneeAgentId: input.assigneeAgentId,
      createdAt: now,
      updatedAt: now
    };

    // Insert the row directly so we can pair it with a thread under a single
    // publish path. persistState's delete-all + re-insert would otherwise
    // truncate newly-written threads on save().
    this.store.runInTransaction(() => {
      this.store.insertTaskRaw(task);
    });
    this.store.appendTasksToMemory([task]);

    // Pair with a kind='task' thread. We guard against double-creation by
    // checking the existing threads for the workspace.
    const existing = this.threads
      .listThreads(input.workspaceId)
      .find((t) => t.taskId === id && t.kind === "task");
    const thread =
      existing ??
      this.threads.createThread({
        workspaceId: input.workspaceId,
        kind: "task",
        taskId: id
      });

    this.events.publish({
      type: "task.updated",
      action: "created",
      taskId: task.id,
      task
    });
    return { task, thread };
  }

  public async updateColumn(
    taskId: string,
    next: TaskColumn,
    actor: TaskActor
  ): Promise<Task> {
    const existing = this.requireTask(taskId);
    if (existing.column === next) {
      return existing;
    }

    const key = `${existing.column}->${next}` as const;
    const allowed = actor === "user" ? USER_ALLOWED : SYSTEM_ALLOWED;
    if (!allowed.has(key)) {
      throw new AppError(
        409,
        "TASK_INVALID_TRANSITION",
        `Task ${taskId}: ${actor} cannot move ${existing.column} → ${next}`
      );
    }

    // Invariant: column='running' must be entered only when a Run is queued
    // or running for this task. We rely on the system actor (run-lifecycle)
    // to honour this; the user path already blocks *->running.
    if (actor === "user" && existing.column === "running") {
      // User cannot pull a running task out of running without cancelling
      // the run first. Run cancellation lives outside TaskService.
      throw new AppError(
        409,
        "TASK_RUNNING",
        `Task ${taskId} is running; cancel the run before changing columns`
      );
    }

    const updated = await this.store.updateTask(taskId, (task) => ({
      ...task,
      column: next,
      updatedAt: new Date().toISOString()
    }));
    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: updated.id,
      task: updated
    });
    return updated;
  }

  public async onRunFinished(
    taskId: string,
    outcome: RunFinishOutcome
  ): Promise<Task> {
    const existing = this.requireTask(taskId);
    if (existing.column !== "running") {
      // Run ended on a task that isn't currently in 'running' — nothing to do.
      return existing;
    }
    const next: TaskColumn = outcome === "interrupted" ? "todo" : "review";
    return this.updateColumn(taskId, next, "system");
  }

  public async approveReview(
    taskId: string,
    actor: { userId?: string } = {}
  ): Promise<Task> {
    void actor;
    const existing = this.requireTask(taskId);
    if (existing.column !== "review") {
      throw new AppError(
        409,
        "TASK_NOT_IN_REVIEW",
        `Task ${taskId} is in ${existing.column}, not review`
      );
    }
    return this.updateColumn(taskId, "done", "system");
  }

  public async rejectReview(
    taskId: string,
    actor: { userId?: string },
    reason: string
  ): Promise<Task> {
    const existing = this.requireTask(taskId);
    if (existing.column !== "review") {
      throw new AppError(
        409,
        "TASK_NOT_IN_REVIEW",
        `Task ${taskId} is in ${existing.column}, not review`
      );
    }

    const updated = await this.store.updateTask(taskId, (task) => ({
      ...task,
      column: "done",
      rejected: true,
      updatedAt: new Date().toISOString()
    }));

    // Append a plan_decision-shaped message to the task thread so the UI and
    // any upstream coordinator can observe the rejection.
    const thread = this.threads
      .listThreads(existing.workspaceId)
      .find((t) => t.taskId === taskId && t.kind === "task");
    if (thread) {
      this.threads.appendMessage({
        threadId: thread.id,
        sender: { type: "system" },
        kind: "plan_decision",
        payload: {
          decision: "reject",
          taskId,
          reason,
          approverUserId: actor.userId
        }
      });
    }

    this.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: updated.id,
      task: updated
    });
    return updated;
  }

  /**
   * Cancels all non-terminal subtasks of a plan. Returns the number of tasks
   * archived. Called by PlanService/Orchestrator when a plan is abandoned.
   */
  public async cancelPendingTasksForPlan(planId: string): Promise<number> {
    const cancellable: Task[] = this.store
      .listTasks()
      .filter(
        (t) =>
          t.planId === planId &&
          t.column !== "done" &&
          t.column !== "archived"
      );

    let count = 0;
    const now = new Date().toISOString();
    for (const task of cancellable) {
      const updated = await this.store.updateTask(task.id, (t) => ({
        ...t,
        column: "archived",
        cancelledAt: now,
        updatedAt: now
      }));
      this.events.publish({
        type: "task.updated",
        action: "updated",
        taskId: updated.id,
        task: updated
      });
      count += 1;
    }
    return count;
  }
}
