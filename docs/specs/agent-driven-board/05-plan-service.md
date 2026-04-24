# Spec 05 — PlanService: propose / approve (single-tx CAS + task creation) / reject

## Goal

Introduce `PlanService` — the single owner of the `plans` table and its side effects on `tasks` + `messages`. Approve/reject must be atomic (single SQLite transaction + CAS on `status`) to fix the current `BoardService.approveProposal` race and orphan-task issues.

## Prerequisites

- Spec 02 (types), Spec 03 (migration), Spec 04 (ThreadService — PlanService appends `plan_draft` / `plan_decision` messages through it).

## Scope

- `packages/server/src/services/plan-service.ts` — new.
- `packages/server/src/services/plan-service.test.ts` — new, with concurrency + rollback coverage.
- `packages/server/src/app.ts` — mount `/api/plans/:id/approve` and `/reject`.

## API surface

```ts
class PlanService {
  propose(input: {
    threadId: string;
    proposerAgentId: string;
    drafts: PlanDraft[];
  }): Plan; // inserts plan(pending) + appends plan_draft message to thread

  approve(planId: string, approver: { userId?: string }): Plan;
  // Single transaction:
  //   1. CAS plans.status: pending → approved (fail if not pending)
  //   2. INSERT tasks[] from drafts, source='agent_plan', plan_id=planId,
  //      assignee_agent_id per draft
  //   3. INSERT messages (kind='plan_decision', payload={decision:'approve',planId})
  //      into the same thread
  //   4. Commit
  // Post-commit: emit 'plan.updated' + 'task.created' events + 'thread.message'

  reject(planId: string, approver: { userId?: string }, reason?: string): Plan;
  // Similar single-tx: CAS + plan_decision message. No task inserts.

  supersede(planId: string, reason: string): Plan;
  // Only callable when plan is pending. Used when coordinator proposes a new plan
  // that replaces an earlier pending one.

  getPlan(id: string): Plan | undefined;
  listPlansByThread(threadId: string): Plan[];
}
```

## Concurrency semantics

- All state-mutating methods use a single `db.transaction(...)` (sqlite better-sqlite3 sync transaction is fine since we're single-process).
- CAS is `UPDATE plans SET status=? WHERE id=? AND status='pending'`; check `changes()` == 1. If 0, throw `PlanAlreadyDecidedError`.
- Task inserts happen inside the same transaction. If any insert fails (FK violation, unique clash), the CAS is rolled back — plan stays `pending`. No orphan tasks.

## Approve → subtask creation rules

Each `PlanDraft` becomes one `Task` with:

| Task field | Value |
|---|---|
| `id` | new UUID |
| `workspace_id` | thread's `workspace_id` |
| `title` | `draft.title` |
| `description` | `draft.description` |
| `column` | `'todo'` |
| `source` | `'agent_plan'` |
| `plan_id` | `plan.id` |
| `assignee_agent_id` | `draft.assigneeAgentId ?? null` |
| `dependencies` | resolved from `draft.dependsOn` via sibling drafts' newly-assigned task IDs |
| `created_at` | `NOW()` |

`dependsOn` referenced by draft title; we build a map `title → taskId` inside the transaction before resolving. If a reference doesn't resolve (typo), the whole approval aborts — better to surface the error than create a half-wired dep graph.

## REST routes

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/plans/:id` | — | `Plan` |
| POST | `/api/plans/:id/approve` | `{}` | `Plan` |
| POST | `/api/plans/:id/reject` | `{ reason?: string }` | `Plan` |

Note: plan creation happens server-side from Orchestrator (coordinator tool call), not via REST.

## WebSocket events

- `plan.created` on `propose`.
- `plan.updated` on `approve` / `reject` / `supersede`.
- `thread.message` for the `plan_draft` / `plan_decision` rows (emitted by `ThreadService.appendMessage` under the hood).
- `task.created` for each subtask produced by approve (emitted by the existing task broadcast path; PlanService calls into `TaskService.emitCreated` if available, else raw emit).

## Tests

- **Concurrency**: two `approve(planId)` calls race → one wins, the other throws `PlanAlreadyDecidedError`; only one set of tasks exists.
- **Rollback**: mock the task insert to throw on the 3rd of 5 drafts → plan remains `pending`, zero tasks inserted, no `plan_decision` message persisted.
- **dependsOn resolution**: draft B depends on draft A by title → inserted tasks reflect `dependencies = [taskA.id]`.
- **Supersede**: pending plan + supersede → status transitions, new plan can be created in same thread.

## Out of scope

- Actually running the approved tasks — that's Orchestrator (Spec 07) reacting to the subsequent `system_event` injection.
- Removing `BoardService.approveProposal` (Spec 09).
- Any UI (Spec 08).
