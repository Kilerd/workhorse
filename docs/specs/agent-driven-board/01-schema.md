# Spec 01 — Schema: new tables + task field extension

## Goal

Introduce four new SQLite tables (`threads`, `messages`, `plans`, `agent_sessions`) and extend `tasks` with three new columns. **Legacy tables (`teams`, `team_messages`, `workspace_channels`, `channel_messages`, `task_messages`, `coordinator_proposals`) are untouched.**

This is a schema-only PR. No service, runner, or UI code changes. No data writes to new tables yet.

## Prerequisites

None.

## Scope

- `packages/server/src/persistence/schema.ts` — add new table definitions.
- `packages/server/drizzle/` — generated migration SQL.
- `packages/server/drizzle.config.ts` — no change expected.

## New tables

### `threads`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `workspace_id` | TEXT NOT NULL | FK → `workspaces` |
| `kind` | TEXT NOT NULL | `"coordinator" \| "task" \| "direct"` |
| `task_id` | TEXT NULL | FK → `tasks` (only when `kind="task"`) |
| `coordinator_agent_id` | TEXT NULL | FK → `workspace_agents` (the main coordinator for this thread) |
| `coordinator_state` | TEXT NOT NULL DEFAULT `"idle"` | `"idle" \| "queued" \| "running"` |
| `created_at` | TEXT NOT NULL | ISO-8601 |
| `archived_at` | TEXT NULL | |

Indexes: `(workspace_id, kind)`, `(task_id)`.

### `messages`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `thread_id` | TEXT NOT NULL | FK → `threads` |
| `sender_type` | TEXT NOT NULL | `"user" \| "agent" \| "system"` |
| `sender_agent_id` | TEXT NULL | workspace_agent_id when sender_type=agent |
| `kind` | TEXT NOT NULL | `"chat" \| "status" \| "artifact" \| "plan_draft" \| "plan_decision" \| "system_event"` |
| `payload` | TEXT NOT NULL | JSON; structure depends on kind |
| `consumed_by_run_id` | TEXT NULL | set when the message has been fed into a coordinator run |
| `created_at` | TEXT NOT NULL | |

Indexes: `(thread_id, created_at)`, `(thread_id, consumed_by_run_id) WHERE consumed_by_run_id IS NULL` — partial index for the "pending to consume" query.

### `plans`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `thread_id` | TEXT NOT NULL | FK → `threads` |
| `proposer_agent_id` | TEXT NOT NULL | FK → `workspace_agents` |
| `status` | TEXT NOT NULL | `"pending" \| "approved" \| "rejected" \| "superseded"` |
| `drafts` | TEXT NOT NULL | JSON array of `{title, description, assignee_agent_id?, depends_on?}` |
| `approved_at` | TEXT NULL | |
| `created_at` | TEXT NOT NULL | |

Indexes: `(thread_id, status)`.

### `agent_sessions`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `workspace_id` | TEXT NOT NULL | |
| `agent_id` | TEXT NOT NULL | FK → `workspace_agents` |
| `thread_id` | TEXT NOT NULL UNIQUE | one session per thread |
| `runner_session_key` | TEXT NULL | opaque; claude `--resume` id / codex session id |
| `created_at` | TEXT NOT NULL | |

## `tasks` table additions

Add three columns, all nullable or with defaults — zero impact on existing rows:

| Column | Type | Default |
|---|---|---|
| `source` | TEXT NOT NULL | `'user'` |
| `plan_id` | TEXT NULL | NULL |
| `assignee_agent_id` | TEXT NULL | NULL |

Note: `team_id` and `team_agent_id` stay — they'll be dropped in Spec 09.

## Verification

- `npm run build` at repo root: green.
- `cd packages/server && npm run db:generate` (or equivalent drizzle-kit command) produces a migration file.
- Apply the migration on a fresh sqlite file: all tables created, existing `tasks` rows gain `source='user'`.
- Apply the migration on a copy of an existing `~/.workhorse/state.sqlite`: no data loss, no constraint violations.
- Write a small integration test: insert a `thread` + `message` row, read back, assert fields round-trip.

## Out of scope

- Writing to the new tables from services (covered by Spec 04+).
- Backfilling legacy data (Spec 03).
- Removing legacy columns/tables (Spec 09).
