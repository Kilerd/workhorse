# Phase 2 PR1: SQLite + Drizzle ORM Data Layer Migration

## Background

Prior to this migration, all application state was persisted as a single
`~/.workhorse/state.json` file, with run log output written as per-run NDJSON
files in `~/.workhorse/logs/`. While simple, this approach had several
limitations:

- Full file rewrite on every save (no partial updates)
- No relational integrity (e.g., dependency IDs could reference non-existent tasks)
- Log files required filesystem management (path creation, directory creation)
- Difficult to add aggregate queries without loading everything into memory

This spec describes the migration to SQLite as the persistence backend, using
Drizzle ORM for type-safe query building.

## Goals

1. Replace JSON file persistence with SQLite (`~/.workhorse/workhorse.db`)
2. Store run log entries in SQLite instead of NDJSON files
3. Provide a one-shot migration path from the legacy JSON format
4. Maintain full backward compatibility with the existing `StateStore` public API
5. Support `:memory:` mode for fast in-process testing

## Non-Goals

- Removing the in-memory state cache (kept for performance)
- Changing the `BoardService` or other caller APIs
- Adding new query patterns beyond what the existing API supports

## Schema Design

### `settings`

| column | type | notes |
|--------|------|-------|
| `key`  | TEXT PK | always `"global"` |
| `value` | TEXT | JSON-encoded `GlobalSettings` |

### `workspaces`

| column | type | notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `name` | TEXT | |
| `root_path` | TEXT | |
| `is_git_repo` | INTEGER | boolean |
| `codex_settings` | TEXT | JSON |
| `prompt_templates` | TEXT | JSON, nullable |
| `created_at` | TEXT | ISO 8601 |
| `updated_at` | TEXT | ISO 8601 |

### `tasks`

| column | type | notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `title` | TEXT | |
| `description` | TEXT | |
| `workspace_id` | TEXT | |
| `column` | TEXT | `TaskColumn` value |
| `task_order` | REAL | sort order within column |
| `runner_type` | TEXT | |
| `runner_config` | TEXT | JSON |
| `plan` | TEXT | nullable |
| `worktree` | TEXT | JSON |
| `last_run_id` | TEXT | nullable |
| `continuation_run_id` | TEXT | nullable |
| `pull_request_url` | TEXT | nullable |
| `pull_request` | TEXT | JSON, nullable |
| `created_at` | TEXT | ISO 8601 |
| `updated_at` | TEXT | ISO 8601 |

### `task_dependencies` (junction table)

| column | type | notes |
|--------|------|-------|
| `task_id` | TEXT | composite PK |
| `dep_id` | TEXT | composite PK |

Indexed on `task_id` for efficient dependency lookup per task.

### `runs`

| column | type | notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `task_id` | TEXT | indexed |
| `status` | TEXT | `RunStatus` value |
| `runner_type` | TEXT | |
| `command` | TEXT | |
| `pid` | INTEGER | nullable |
| `exit_code` | INTEGER | nullable |
| `started_at` | TEXT | ISO 8601 |
| `ended_at` | TEXT | nullable |
| `log_file` | TEXT | nullable (legacy path, kept for compat) |
| `metadata` | TEXT | JSON, nullable |

### `run_log_entries`

| column | type | notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `run_id` | TEXT | indexed |
| `timestamp` | TEXT | ISO 8601 |
| `stream` | TEXT | `RunLogStream` value |
| `kind` | TEXT | `RunLogKind` value |
| `entry_text` | TEXT | log line content |
| `title` | TEXT | nullable |
| `source` | TEXT | nullable |
| `metadata` | TEXT | JSON, nullable |

## Implementation

### `StateStore` API Compatibility

The public `StateStore` interface is unchanged. All existing callers
(`BoardService`, `RunLifecycleService`, `TaskScheduler`, `AiReviewService`,
`PrMonitorService`) continue to work without modification.

The `setX() + save()` write pattern remains valid. Internally:

- `setX()` methods update the in-memory `AppState` buffer
- `save()` writes the entire in-memory state to SQLite in a single transaction
- `updateState(updater)` applies the updater to a deep-clone, persists, then
  updates the in-memory buffer — all under the existing write barrier
- `updateTask(taskId, updater)` delegates to `updateState`

### Run Log Storage

`appendLogEntry()` now performs a direct `INSERT` into `run_log_entries`.
`readLogEntries()` performs a `SELECT WHERE run_id = ?`. Neither operation
touches the in-memory `AppState`, so they are safe to call concurrently with
other read operations.

### `Run.logFile` Field

`Run.logFile` is now optional (`logFile?: string`). New runs do not have a
`logFile` path set. The field is retained for backward compatibility with
existing persisted data that was migrated from the JSON format.

### Database Initialization

On `load()`:

1. Open (or create) `workhorse.db` in the `dataDir`
2. Enable WAL journal mode for concurrent read performance
3. Enable foreign keys
4. Run `CREATE TABLE IF NOT EXISTS` for all tables (idempotent)
5. Detect and run the one-shot JSON migration if needed
6. Load state from SQLite into the in-memory buffer

### One-Shot JSON Migration

Triggered when:
- `state.json` exists in `dataDir`, AND
- The `settings` table has no `"global"` row (DB is empty)

Steps:
1. Read and parse `state.json` through the existing `migrateJsonState` helper
2. Collect all legacy NDJSON log entries from `logs/*.log`
3. Write everything to SQLite in a single transaction
4. Rename `state.json` → `state.json.backup`
5. Rename `logs/` → `logs.backup/`

Migration failure does not corrupt the original data (transaction rollback +
backups not yet deleted).

### In-Memory Mode (`:memory:`)

Passing `":memory:"` as `dataDir` to `StateStore` enables in-memory SQLite.
Table creation and all operations work identically, but no files are written.
This mode is used by all unit and integration tests.

## Testing

- `state-store.test.ts` updated to use `new StateStore(":memory:")` throughout
- New test cases: settings persistence, task dependencies roundtrip, log entry
  append/read
- `app.test.ts` continues to use `mkdtemp`-based stores for persistence tests
  (orphaned run recovery tests require two separate `StateStore` instances
  sharing the same file-based database)
- All 152 existing tests pass; the 1 pre-existing failure in
  `git-worktree.test.ts` is unrelated to this change

## Files Changed

| file | change |
|------|--------|
| `packages/contracts/src/domain.ts` | `Run.logFile` made optional |
| `packages/server/src/persistence/schema.ts` | **new** — Drizzle schema definitions |
| `packages/server/src/persistence/state-store.ts` | rewritten — SQLite backend |
| `packages/server/src/persistence/state-store.test.ts` | updated — `:memory:` mode + new tests |
| `packages/server/package.json` | added `drizzle-orm`, `better-sqlite3`, `@types/better-sqlite3`, `drizzle-kit` |
