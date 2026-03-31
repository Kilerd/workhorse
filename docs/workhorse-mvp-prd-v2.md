# Workhorse MVP PRD v2

## Goal

Build a local-first kanban tool inspired by `cline/kanban` for coordinating tasks across multiple workspace directories.

The MVP focuses on three complete loops:

- multi-workspace kanban aggregation
- task execution
- realtime log observation

## Non-goals

- git worktree management
- diff review
- dependency chains between tasks
- automatic commit, PR, or cloud sync
- multi-user collaboration

## Product scope

- Register multiple local workspaces and view their tasks in one board
- Fixed columns: `Todo`, `Running`, `Review`, `Done`, `Archived`
- Create tasks with either `shell` or `codex` runner config
- Start and stop tasks from the board or detail panel
- Stream output while a task is running
- Persist state and logs locally across refreshes
- Move active tasks to `Running` and completed tasks to `Review`

## Architecture

- Monorepo with `contracts`, `server`, `api-client`, and `web`
- Shared TypeScript contracts are the source of truth for domain and REST types
- Typia provides request validation and OpenAPI schema generation
- Hono serves the runtime API and WebSocket event stream
- React consumes the generated API client and live WebSocket events
- Codex integration uses ACP by connecting to `codex app-server`

## API shape

- `GET/POST/PATCH/DELETE /api/workspaces`
- `GET/POST/PATCH/DELETE /api/tasks`
- `POST /api/tasks/:taskId/start`
- `POST /api/tasks/:taskId/stop`
- `GET /api/tasks/:taskId/runs`
- `GET /api/runs/:runId/log`
- `GET /openapi.json`

REST responses use `ApiSuccess<T> | ApiError`.

## Persistence

- `~/.workhorse/state.json`
- `~/.workhorse/logs/<runId>.log`

On restart, unfinished runs are marked `canceled` and their tasks return to `Review`.

## Acceptance

- `npm install && npm run dev` starts the system
- The user can register two or more workspaces
- The user can create tasks and start them
- The user can observe live output and persisted logs
- The frontend consumes generated OpenAPI client code instead of hand-written fetches
