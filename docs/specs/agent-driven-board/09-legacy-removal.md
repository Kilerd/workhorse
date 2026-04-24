# Spec 09 — Legacy removal: drop old tables, shrink BoardService, delete dead code

## Goal

After Specs 01–08 have been in production for a stable window (suggested: one release cycle, or when kilerd confirms no regressions), remove the parallel legacy system. This is a purely deletion-focused spec — the behaviors all live in the new services already.

**This spec is destructive** and hard to revert. Do not merge until the new system has been verified live.

## Prerequisites

- Specs 01–08 landed and observed as stable.
- `board-service.ts` methods that still have callers have been audited — each caller is traced to either (a) the new service or (b) a legacy endpoint that will be removed in this spec.

## Scope

### Server-side deletions

- `packages/server/src/services/board-service.ts` — delete. If any utility lives here that's genuinely shared (should not be the case after Specs 04–07), extract to `services/utils.ts` first.
- `packages/server/src/services/team-coordinator-service.ts` — delete.
- `packages/server/src/services/team-subtask-service.ts` — delete.
- `packages/server/src/services/team-pr-service.ts` — fold its remaining PR-creation logic into `pr-service.ts` (called by the `open_pr` tool).
- `packages/server/src/services/task-scheduler.ts` — delete. Run queueing lives in Orchestrator now.
- `packages/server/src/services/ai-review-service.ts` — either delete or convert into a registerable agent; if no agent registers it in the default config, delete outright and rely on the coordinator calling `spawn_agent` on any workspace-registered reviewer.

### Schema drops

Drop these tables (migration script):

- `teams`
- `team_messages`
- `workspace_channels`
- `channel_messages`
- `task_messages`
- `coordinator_proposals`

Drop these columns from `tasks`:

- `team_id`
- `team_agent_id`

Verification: run `SELECT * FROM sqlite_master WHERE type='table'` on a migrated DB — none of the above should appear.

### Contracts deletions

- `packages/contracts/src/domain.ts`:
  - Remove `AgentTeam`, `TeamAgent`, `TeamMessage`, `WorkspaceChannel`, `ChannelMessage`, `TaskMessage`, `CoordinatorProposal`.
  - Remove `Task.teamId`, `Task.teamAgentId`.
- `packages/contracts/src/api.ts`: remove legacy `/api/teams/*`, `/api/workspaces/:wsId/channels/*` request/response types.
- `packages/contracts/src/events.ts`: remove `team.*`, `channel.*`, `team_message.*`, `task_message.*`, `coordinator_proposal.*` event variants.
- Regenerate `packages/api-client`.

### REST route deletions

Remove these handlers from `app.ts`:

- `/api/teams/*`
- `/api/workspaces/:wsId/channels/*`
- `/api/tasks/:id/comments` (legacy task_messages endpoint), if not already forwarded to ThreadService.

### Frontend deletions

- `packages/web/src/components/TeamMessageFeed.tsx` — delete.
- `packages/web/src/components/WorkspaceChannelPage.tsx` — delete if its only usage was the legacy channel sub-tree; otherwise refactor into a thin wrapper around ThreadView.
- `packages/web/src/components/CoordinatorProposalPanel.tsx` — delete.
- `packages/web/src/pages/TeamsPage.tsx` (or equivalent) — delete.
- `packages/web/src/hooks/useTeams.ts`, `useCoordination.ts` — delete.
- `packages/web/src/lib/coordination.ts` — delete (`CoordinationScope` type no longer needed).
- Remove all imports of the above.

### WebSocket event cleanup

Remove legacy event emission paths in `app.ts` / event bus. Only `thread.*`, `plan.*`, `task.*`, `run.*`, `agent.*` should remain.

## Data considerations

- Since Spec 03 already copied all legacy content into the new tables, dropping the legacy tables loses no user-visible state.
- Emit a dump of pre-drop row counts to the log for audit. Example: `{ teams: 3, team_messages: 142, ... }`.

## Tests

- Full test suite passes with all legacy files removed.
- `npm run build` at root — green.
- `npm run typecheck` — green.
- Integration: boot against a fresh DB + boot against a migrated DB — both work; no references to dropped tables remain.
- Manual smoke: repeat Spec 08's 5-step smoke test; nothing regressed.

## Rollback plan

If this spec ships and something breaks in production:

- The dropped tables can be recreated from the `0XX_drop_legacy.sql` migration's inverse — but the data is gone. Recovery path: restore a pre-deploy SQLite backup.
- Recommendation: keep an automatic backup of `~/.workhorse/state.sqlite` on first boot after this migration, stored at `state.sqlite.pre-legacy-drop.bak`.

## Out of scope

- Any new feature work.
- Performance tuning.
- Re-architecting what's left of the server.
