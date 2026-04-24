# Spec 08 — Frontend: ThreadView + inline PlanDraftCard + hook consolidation

## Goal

Flip the web UI to the new thread/plan model. After this spec:

- A single `ThreadView` component renders all conversational surfaces (`#coordinator`, task threads, direct threads).
- Plans render inline in the thread as a `PlanDraftCard` with approve/reject actions — no separate proposal panel.
- `useTeams` / `useCoordination` / channel-related hooks merge into `useThreads` + `usePlans`.
- The Board shows a small badge on `source='agent_plan'` task cards so users can tell agent-planned tasks apart from user-created ones.

Legacy pages (`TeamsPage`, `WorkspaceChannelPage`'s channel sub-tree) stay mounted until Spec 09, but the main `#coordinator` entry now points at the new ThreadView.

## Prerequisites

- Spec 07 landed — server-side endpoints `/api/workspaces/:wsId/threads`, `/api/threads/:id/messages`, `/api/plans/:id/approve|reject` are live.

## Scope

### New / rewritten components

- `packages/web/src/components/ThreadView.tsx` — new.
  - Props: `{ threadId: string }`.
  - Renders ordered messages: chat / status / artifact / plan_draft / plan_decision / system_event.
  - Input box at the bottom → `POST /api/threads/:id/messages`.
  - Shows `coordinatorState` hint: "coordinator is thinking… N messages queued" when `state='running'` and `listPendingMessages > 0`.
- `packages/web/src/components/PlanDraftCard.tsx` — new.
  - Props: `{ plan: Plan }`.
  - Rendered inside ThreadView when a message has `kind='plan_draft'` and links to a plan.
  - Shows drafts as a compact list (title, description snippet, assignee chip, deps).
  - Approve / Reject buttons → `POST /api/plans/:id/approve|reject`.
  - Disabled state when `plan.status !== 'pending'`.
- `packages/web/src/components/SystemEventMessage.tsx` — small renderer for `kind='system_event'` (task finished, plan approved, etc.); styled as a subtle divider row.
- `packages/web/src/components/Board.tsx` — add a `source` badge on task cards:
  - `source='user'` → no badge (default).
  - `source='agent_plan'` → small "🤖 plan" pill (actual text only, no emoji unless kilerd wants it; default: the word "plan" in a muted pill).
  - Clicking the pill opens the linked plan in its thread.

### Hooks

- `packages/web/src/hooks/useThreads.ts` — new.
  - `useWorkspaceThreads(workspaceId)` → list.
  - `useThreadMessages(threadId)` → messages + WS subscription (`thread.message` events patch the cache).
  - `usePostThreadMessage(threadId)` → mutation.
- `packages/web/src/hooks/usePlans.ts` — new.
  - `usePlan(planId)`, `useApprovePlan`, `useRejectPlan`.
- Deprecate (keep files but stop using from new pages):
  - `useTeams.ts` — only used by `TeamsPage`.
  - `useCoordination.ts` — only used by `CoordinatorProposalPanel`.

### Route / App changes

- `packages/web/src/App.tsx` — workspace main view:
  - Primary tab / default route inside a workspace = `#coordinator` thread via ThreadView.
  - Task detail drawer renders ThreadView for that task's thread alongside run logs.
- `packages/web/src/components/TeamMessageFeed.tsx` — unchanged; still used by `TeamsPage`.
- `packages/web/src/components/WorkspaceChannelPage.tsx` — replace channel message area with ThreadView; keep outer chrome for now.
- `packages/web/src/lib/coordination.ts` — stop using `CoordinationScope` for new paths. File stays until Spec 09 removes legacy.

### WebSocket event handling

- `packages/web/src/lib/ws.ts` (or wherever event routing lives) — add handlers for:
  - `thread.message` → patch `useThreadMessages(threadId)` cache.
  - `thread.updated` → patch thread record + `coordinatorState`.
  - `plan.created` / `plan.updated` → patch `usePlan(planId)` cache.
- Existing `team.*` / `channel.*` handlers stay for legacy pages.

## UX details

- ThreadView scroll behavior: pin-to-bottom on new messages unless user has scrolled up.
- PlanDraftCard: collapse by default when there are >3 drafts; show "N drafts" with an expand button.
- Pending message hint: "coordinator is thinking… X messages queued" uses `thread.coordinatorState === 'running'` + client-side count of messages after the last `consumed_by_run_id`. Cheap to compute from already-loaded messages.
- Board `source='agent_plan'` badge links to `/workspaces/:wsId/threads/:threadId` of the plan's thread, scrolled to the plan_draft message.

## Tests

- Unit: ThreadView renders all `MessageKind` variants without crashing.
- Unit: PlanDraftCard disables approve/reject when `status !== 'pending'`.
- Integration (React Testing Library): typing + send → mutation fires with `{ content, kind: 'chat' }`.
- Manual smoke (kilerd):
  1. Open workspace, default view is `#coordinator`.
  2. Send "implement README FAQ section".
  3. Observe a `plan_draft` card inside the thread; approve it.
  4. Board tab shows N new cards with the plan badge.
  5. Cards advance through columns driven by the new Orchestrator.

## Out of scope

- Deleting `TeamsPage`, `CoordinatorProposalPanel`, `TeamMessageFeed` (Spec 09).
- Visual redesign beyond what's needed to drop new components in — keep shadcn baseline.
- Virtualized lists / perf tuning — defer to a separate task if ThreadView gets slow.
