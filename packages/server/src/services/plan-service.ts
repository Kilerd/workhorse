import type {
  Message,
  Plan,
  PlanDraft,
  PlanStatus,
  Task
} from "@workhorse/contracts";

import { AppError, ensure } from "../lib/errors.js";
import { createId } from "../lib/id.js";
import { createTaskWorktree } from "../lib/task-worktree.js";
import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";

export interface ProposeInput {
  threadId: string;
  proposerAgentId: string;
  drafts: PlanDraft[];
}

export interface Approver {
  userId?: string;
}

export interface ApproveResult {
  plan: Plan;
  tasks: Task[];
}

// Only 'pending' plans can transition. All terminal statuses are immutable.
const APPROVABLE_FROM: PlanStatus = "pending";

export class PlanService {
  public constructor(
    private readonly store: StateStore,
    private readonly events: EventBus
  ) {}

  // ── Queries ───────────────────────────────────────────────────────────────

  public getPlan(id: string): Plan | undefined {
    return this.store.getPlan(id) ?? undefined;
  }

  public requirePlan(id: string): Plan {
    return ensure(
      this.getPlan(id),
      404,
      "PLAN_NOT_FOUND",
      `Plan ${id} not found`
    );
  }

  public listPlansByThread(threadId: string): Plan[] {
    return this.store.listPlansByThread(threadId);
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Creates a pending Plan and appends a `plan_draft` message to the thread.
   * Both writes commit in a single transaction; events are published after.
   */
  public propose(input: ProposeInput): Plan {
    const thread = ensure(
      this.store.getThread(input.threadId) ?? undefined,
      404,
      "THREAD_NOT_FOUND",
      `Thread ${input.threadId} not found`
    );
    if (thread.archivedAt) {
      throw new AppError(
        409,
        "THREAD_ARCHIVED",
        `Thread ${thread.id} is archived`
      );
    }
    if (input.drafts.length === 0) {
      throw new AppError(400, "PLAN_EMPTY", "Plan must contain at least one draft");
    }

    const now = new Date().toISOString();
    const plan: Plan = {
      id: createId(),
      threadId: input.threadId,
      proposerAgentId: input.proposerAgentId,
      status: "pending",
      drafts: input.drafts,
      createdAt: now
    };
    const message: Message = {
      id: createId(),
      threadId: input.threadId,
      sender: { type: "agent", agentId: input.proposerAgentId },
      kind: "plan_draft",
      payload: { planId: plan.id, drafts: input.drafts },
      createdAt: now
    };

    this.store.runInTransaction(() => {
      this.store.insertPlan(plan);
      this.store.insertMessage(message);
    });

    this.events.publish({
      type: "plan.created",
      planId: plan.id,
      plan
    });
    this.events.publish({
      type: "thread.message",
      threadId: message.threadId,
      message
    });
    return plan;
  }

  /**
   * Atomically: CAS status pending→approved, materialize drafts into tasks,
   * and append a `plan_decision(approve)` message. On any failure the whole
   * transaction rolls back; the plan stays `pending` and no orphan tasks
   * remain.
   */
  public approve(planId: string, approver: Approver = {}): ApproveResult {
    void approver; // reserved for audit metadata; not persisted today
    const current = this.requirePlan(planId);
    if (current.status !== APPROVABLE_FROM) {
      throw planAlreadyDecided(current);
    }

    const thread = ensure(
      this.store.getThread(current.threadId) ?? undefined,
      404,
      "THREAD_NOT_FOUND",
      `Thread ${current.threadId} not found`
    );

    // Pre-build tasks (ids + dependency resolution) before the transaction so
    // draft typos surface as a 400 before we start writing.
    const tasks = buildTasksFromDrafts(current, thread.workspaceId);
    const decisionMessage: Message = {
      id: createId(),
      threadId: current.threadId,
      sender: { type: "system" },
      kind: "plan_decision",
      payload: { decision: "approve", planId, approverUserId: approver.userId },
      createdAt: new Date().toISOString()
    };

    const approvedAt = new Date().toISOString();
    const result = this.store.runInTransaction<ApproveResult>(() => {
      const updated = this.store.casPlanStatus(
        planId,
        "pending",
        "approved",
        approvedAt
      );
      if (!updated) {
        // Another writer decided the plan first. Throw inside the transaction
        // to force a rollback — no tasks, no message persisted.
        throw planAlreadyDecided(current);
      }
      for (const task of tasks) {
        this.store.insertTaskRaw(task);
      }
      this.store.insertMessage(decisionMessage);
      return { plan: updated, tasks };
    });

    // Post-commit: sync in-memory state cache so subsequent reads / save()
    // include the new tasks.
    this.store.appendTasksToMemory(result.tasks);

    this.events.publish({
      type: "plan.updated",
      planId: result.plan.id,
      plan: result.plan
    });
    this.events.publish({
      type: "thread.message",
      threadId: decisionMessage.threadId,
      message: decisionMessage
    });
    for (const task of result.tasks) {
      this.events.publish({
        type: "task.updated",
        action: "created",
        taskId: task.id,
        task
      });
    }
    return result;
  }

  public reject(
    planId: string,
    approver: Approver = {},
    reason?: string
  ): Plan {
    return this.decide(planId, "rejected", approver, { reason });
  }

  public supersede(planId: string, reason: string): Plan {
    return this.decide(planId, "superseded", {}, { reason });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private decide(
    planId: string,
    next: Extract<PlanStatus, "rejected" | "superseded">,
    approver: Approver,
    opts: { reason?: string }
  ): Plan {
    const current = this.requirePlan(planId);
    if (current.status !== APPROVABLE_FROM) {
      throw planAlreadyDecided(current);
    }

    const decisionValue = next === "rejected" ? "reject" : "supersede";
    const message: Message = {
      id: createId(),
      threadId: current.threadId,
      sender: { type: "system" },
      kind: "plan_decision",
      payload: {
        decision: decisionValue,
        planId,
        reason: opts.reason,
        approverUserId: approver.userId
      },
      createdAt: new Date().toISOString()
    };

    const result = this.store.runInTransaction<Plan>(() => {
      const updated = this.store.casPlanStatus(planId, "pending", next);
      if (!updated) {
        throw planAlreadyDecided(current);
      }
      this.store.insertMessage(message);
      return updated;
    });

    this.events.publish({
      type: "plan.updated",
      planId: result.id,
      plan: result
    });
    this.events.publish({
      type: "thread.message",
      threadId: message.threadId,
      message
    });
    return result;
  }
}

function planAlreadyDecided(plan: Plan): AppError {
  return new AppError(
    409,
    "PLAN_ALREADY_DECIDED",
    `Plan ${plan.id} has already been decided`
  );
}

/**
 * Materializes each draft into a Task row. Dependencies are resolved by
 * matching `draft.dependsOn` entries against sibling draft titles inside the
 * same plan — a typo (unresolved title) aborts the entire approval.
 */
function buildTasksFromDrafts(plan: Plan, workspaceId: string): Task[] {
  const now = new Date().toISOString();

  // Pre-assign IDs so dependsOn can map title → taskId in one pass.
  const idByTitle = new Map<string, string>();
  for (const draft of plan.drafts) {
    const key = normalizeTitle(draft.title);
    if (idByTitle.has(key)) {
      throw new AppError(
        400,
        "PLAN_DUPLICATE_TITLE",
        `Plan ${plan.id} has duplicate draft title "${draft.title}"`
      );
    }
    idByTitle.set(key, createId());
  }

  return plan.drafts.map((draft, index) => {
    const id = idByTitle.get(normalizeTitle(draft.title))!;
    const dependencies = (draft.dependsOn ?? []).map((refTitle) => {
      const depId = idByTitle.get(normalizeTitle(refTitle));
      if (!depId) {
        throw new AppError(
          400,
          "PLAN_UNRESOLVED_DEPENDENCY",
          `Draft "${draft.title}" depends on unknown title "${refTitle}"`
        );
      }
      return depId;
    });

    const task: Task = {
      id,
      title: draft.title,
      description: draft.description,
      workspaceId,
      column: "todo",
      order: index,
      runnerType: "shell",
      // Placeholder runner config — the Orchestrator replaces this before the
      // task actually runs, based on the assignee agent's runnerConfig.
      runnerConfig: { type: "shell", command: "" },
      dependencies,
      worktree: createTaskWorktree(id, draft.title),
      taskKind: "user",
      source: "agent_plan",
      planId: plan.id,
      assigneeAgentId: draft.assigneeAgentId,
      createdAt: now,
      updatedAt: now
    };
    return task;
  });
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}
