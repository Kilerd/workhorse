# Spec 03 — Data migration: backfill legacy rows into new tables

## Goal

Write a one-shot migration that copies existing data from legacy tables (`teams`, `team_messages`, `workspace_channels`, `channel_messages`, `task_messages`, `coordinator_proposals`) into the new tables from Spec 01. After this migration, the new tables hold a faithful read-only snapshot of legacy state; legacy tables stay intact (removed in Spec 09).

**Zero runtime behavior change**: no service reads from new tables yet. This spec is a data copy only.

## Prerequisites

- Spec 01 landed (new tables exist).
- Spec 02 landed (types exist; helps write typed queries).

## Scope

- `packages/server/src/persistence/migrations/backfill-agent-driven-board.ts` — new script.
- `packages/server/src/persistence/migrator.ts` — invoke the backfill once on first boot after deploy (idempotent; uses a marker row in a `migration_state` table or similar).
- Unit test: run migrator against a fixture SQLite file and assert row counts + spot-check payloads.

## Mapping rules

### `teams` → no direct equivalent

Legacy `teams` rows are NOT copied to `threads` directly. Instead, they are interpreted:

- If a legacy team has an associated `#coordinator`-like parent task, that parent task's existing channel mapping determines the `Thread`.
- Otherwise, we create a **synthetic `kind="coordinator"` thread** per legacy team so the team's `team_messages` have a home. `coordinatorAgentId` is set to the first agent in the team's `agents` JSON (best-effort).

### `workspace_channels` → `threads`

| Legacy column | New column |
|---|---|
| `id` | `id` (keep same UUID) |
| `workspace_id` | `workspace_id` |
| `kind` ∈ {`coordinator`, `task`} | `kind` (`all` renamed to `coordinator`) |
| `task_id` | `task_id` |
| `coordinator_agent_id` | `coordinator_agent_id` |
| — | `coordinator_state` = `'idle'` |
| `created_at` | `created_at` |

### `team_messages` + `channel_messages` + `task_messages` → `messages`

Unified mapping. For each legacy row:

- `thread_id`:
  - `team_messages`: the synthetic/existing coordinator thread for that team.
  - `channel_messages`: `channel_id` (same UUID).
  - `task_messages`: the `kind="task"` thread for that task (create if missing).
- `sender_type` + `sender_agent_id`: derived from legacy `sender` / `author_agent_id`.
- `kind`:
  - If payload looks like a proposal announcement → `plan_draft` (tied to the matching plan).
  - If payload looks like a decision log → `plan_decision`.
  - If payload has `artifact_path` → `artifact`.
  - If payload has `run_status` / `system_event` marker → `status` or `system_event`.
  - Else → `chat`.
- `payload`: raw JSON from legacy `content`.
- `consumed_by_run_id`: legacy `consumed_by_run_id` if present else NULL.

### `coordinator_proposals` → `plans`

| Legacy column | New column |
|---|---|
| `id` | `id` |
| `channel_id` (or synthesized from team) | `thread_id` |
| `proposer_agent_id` | `proposer_agent_id` |
| `status` | `status` |
| `drafts_json` | `drafts` |
| `approved_at` | `approved_at` |
| `created_at` | `created_at` |

For each migrated plan, also insert a synthetic `messages` row of `kind="plan_draft"` in the owning thread if one doesn't already exist (so the new UI's inline plan card has something to render).

### `tasks` backfill

For existing rows:

- `source = 'user'` for tasks with no `team_id` and no link to a migrated plan.
- `source = 'agent_plan'` + `plan_id = <migrated plan id>` for tasks that came from a legacy proposal.
- `assignee_agent_id = team_agent_id` if legacy column was set and that agent is now a workspace agent; else NULL.

### `agent_sessions`

Nothing to backfill — legacy system didn't track persistent runner sessions. Created fresh when the new ThreadService starts using them (Spec 04).

## Idempotency

- Insert a marker `('agent_driven_board_backfill', NOW())` into `migration_state` on success.
- On boot, if marker exists, skip.
- If the script fails halfway, wrap in a single transaction; on failure rollback and leave new tables empty. Operator can retry.

## Verification

- Fixture test: seed legacy tables with a realistic workspace (2 teams, 3 channels, 50 messages, 2 proposals). Run migration. Assert:
  - `SELECT COUNT(*) FROM messages` == sum of legacy three message tables.
  - `SELECT COUNT(*) FROM plans` == `coordinator_proposals`.
  - Every `tasks.plan_id` points to a real row in `plans`.
  - No dangling FKs.
- Apply on a copy of the maintainer's real `~/.workhorse/state.sqlite`: script completes, row counts match, spot-check messages render as expected JSON.

## Out of scope

- Writing *new* data to these tables from services (Spec 04+).
- Deleting legacy tables (Spec 09).
- Any schema change to legacy tables.
