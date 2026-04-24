# Spec 06 — TaskService: CRUD + column invariants + approve/reject

## Goal

Extract Task-centric operations from `BoardService` into a `TaskService`. Enforce the column invariants from PRD §3.2 — in particular:

- `column='running'` ⇔ exists a `Run` with `status ∈ {queued, running}`. Users cannot drag into `running`.
- `column='review'` is only entered via run completion or user reject.
- Tasks with `source='agent_plan'` are linked to a `plan_id`; deleting/superseding a plan cancels its non-done subtasks.

## Prerequisites

- Spec 02 (types), Spec 04 (ThreadService; each task creates a companion `kind='task'` thread on creation).

## Scope

- `packages/server/src/services/task-service.ts` — new.
- `packages/server/src/services/task-service.test.ts` — new, focused on invariants.
- `packages/server/src/app.ts` — mount routes (overlaps with existing task routes; see Migration section).

## API surface

```ts
class TaskService {
  createTask(input: {
    workspaceId: string;
    title: string;
    description?: string;
    source: "user" | "agent_plan";
    planId?: string;
    assigneeAgentId?: string;
    dependencies?: string[];
    column?: "backlog" | "todo"; // default 'todo' for user, 'todo' for agent_plan
  }): Task;
  // Side effect: also creates the kind='task' thread for this task via ThreadService.

  getTask(id: string): Task | undefined;
  listTasks(workspaceId: string, filter?: { column?, source?, planId? }): Task[];

  updateColumn(taskId: string, next: TaskColumn, actor: "user" | "system"): Task;
  // Enforces invariants:
  //  - actor='user': blocks next='running'; blocks next='review' if current is 'running' with active Run.
  //  - actor='system': all transitions allowed.

  cancelPendingTasksForPlan(planId: string): number;
  // Called by PlanService on supersede: cancels tasks in {backlog,todo,blocked}; returns count.

  approveReview(taskId: string, actor: { userId?: string }): Task;
  // review → done

  rejectReview(taskId: string, actor: { userId?: string }, reason: string): Task;
  // review → done (with `rejected` flag in task payload / log)
  // Appends a plan_decision-style message to the task thread.

  // Run integration hooks — called by RunLifecycleService when a worker run finishes.
  onRunFinished(taskId: string, outcome: "succeeded" | "failed" | "interrupted"): Task;
  // Atomically transitions running → review (or back to todo on interrupted, depending on config).
}
```

## Column state machine

Identical to the PRD §3.2 diagram. Encoded as a lookup table inside TaskService:

```ts
const USER_ALLOWED = new Set<`${TaskColumn}->${TaskColumn}`>([
  "backlog->todo", "backlog->archived",
  "todo->backlog", "todo->archived",
  "blocked->todo", "blocked->archived",
  "done->archived",
  // user cannot touch running / review from above
]);

const SYSTEM_ALLOWED = /* all transitions from state diagram */;
```

Any attempt outside the set throws `InvalidTaskTransitionError`.

## Thread creation on task create

Every new task gets a paired `kind='task'` thread, keyed by `task_id`. ThreadService.createThread idempotency is ensured by a unique index on `(task_id)` when `kind='task'` (add this via an ALTER in this spec if not already present — otherwise via a `WHERE task_id IS NOT NULL AND kind='task'` partial unique index).

## REST routes

Existing task routes in `app.ts` delegate to `TaskService` but keep the same path shapes:

| Method | Path | Handler |
|---|---|---|
| POST | `/api/workspaces/:wsId/tasks` | `createTask({source:'user'})` |
| GET | `/api/workspaces/:wsId/tasks` | `listTasks` |
| PATCH | `/api/tasks/:id/column` | `updateColumn(actor='user')` |
| POST | `/api/tasks/:id/review/approve` | `approveReview` |
| POST | `/api/tasks/:id/review/reject` | `rejectReview` |

`BoardService`'s existing handlers gradually delegate. For this spec, `BoardService.createTask` can internally forward to `TaskService.createTask` — both paths co-exist.

## Tests

- **User drag invariants**: `updateColumn(taskId, 'running', 'user')` throws; `updateColumn(taskId, 'review', 'user')` throws when current is 'running'.
- **Plan cancellation**: approve plan → cancel plan → non-done subtasks all go to `archived`/`cancelled` column.
- **Run-finish transition**: simulate `onRunFinished(id, 'succeeded')` → column='review', companion thread has an artifact/status message.
- **Thread pairing**: create 5 tasks → 5 threads exist with the matching `task_id`s.

## Out of scope

- The actual Run execution (unchanged — still in RunLifecycleService).
- Removing BoardService task methods (Spec 09).
- UI changes (Spec 08).
