# Workhorse

Workhorse is a local-first kanban runtime for managing tasks across multiple workspaces.

## Stack

- Frontend: React + Vite + TypeScript
- Backend: Hono + Node + TypeScript
- Contracts: shared TypeScript models with Typia validators and OpenAPI generation
- API client: `openapi-typescript` + `openapi-typescript-fetch`
- Realtime: WebSocket event stream for run output and status changes
- Task runners: `shell` and Codex ACP via `codex app-server`

## Packages

- `packages/contracts`: domain models, REST DTOs, validators, OpenAPI generation
- `packages/server`: Hono runtime, persistence, runners, WebSocket server
- `packages/api-client`: generated OpenAPI client wrapper
- `packages/web`: React kanban UI

## Development

```bash
npm install
npm run dev
```

Services:

- App and API: [http://127.0.0.1:3999](http://127.0.0.1:3999)
- Health: [http://127.0.0.1:3999/api/health](http://127.0.0.1:3999/api/health)
- OpenAPI: [http://127.0.0.1:3999/openapi.json](http://127.0.0.1:3999/openapi.json)

## Useful scripts

```bash
npm run build
npm run test
npm run generate:openapi
npm run generate:client
npm run check:contracts
```

To run the built app from the same single port:

```bash
node packages/server/dist/index.js
```

## Runtime data

By default Workhorse stores local state under `~/.workhorse`:

- `state.json`: workspaces, tasks, runs
- `logs/<runId>.log`: persisted run logs

## Notes

- Codex tasks use ACP over WebSocket by launching `codex app-server --listen ...`.
- Git-backed Codex tasks are instructed to commit, push, and open a GitHub PR before they finish.
- Review tasks can be polled in the background with `gh` to detect whether their PR is behind/conflicting and whether required CI checks are passing.
- When a review PR is merged, Workhorse automatically moves the task from `review` to `done`.
- When a review PR is reported as `BEHIND` or conflicting, Workhorse can automatically restart the task, rebase onto its configured base ref, and move it back to `review` once the rerun finishes.
- Authenticate `gh` locally with `gh auth login` before relying on PR polling.
- The review poller defaults to `15000` milliseconds. Use `WORKHORSE_GIT_REVIEW_MONITOR_INTERVAL_MS=0` to disable it, or set it to a custom interval in milliseconds.
- If the runtime restarts while a task is active, the previous run is marked as `canceled` and the task moves to `review`.
