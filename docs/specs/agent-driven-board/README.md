# Agent-Driven Board Refactor — Spec Index

> Parent PRD: [`../../prd/agent-driven-board.md`](../../prd/agent-driven-board.md) (v0.2)

This directory splits the PRD into self-contained specs. Each spec is one PR worth of work.

## Guiding principle

**Code is a Tool Server; Agent is the Workflow Engine.** Every spec here either (a) exposes a stable API for agents, (b) enforces a data invariant, or (c) removes workflow logic that should live in agent prompts/skills.

## Specs

| # | Spec | Goal | Depends on |
|---|---|---|---|
| 01 | [schema.md](./01-schema.md) | Add `threads` / `messages` / `plans` / `agent_sessions` tables + extend `tasks`. Legacy tables untouched. | — |
| 02 | [contracts.md](./02-contracts.md) | Add `Thread` / `Message` / `Plan` / `AgentSession` domain types + API schemas. Legacy types kept. | 01 |
| 03 | [data-migration.md](./03-data-migration.md) | Backfill legacy rows (`team_messages`, `channel_messages`, `task_messages`, `workspace_channels`, `coordinator_proposals`) into new tables. | 01, 02 |
| 04 | [thread-service.md](./04-thread-service.md) | Extract `ThreadService`: CRUD + message append + session-state machine (idle/queued/running). | 02, 03 |
| 05 | [plan-service.md](./05-plan-service.md) | Extract `PlanService`: propose / approve (single-tx CAS + task creation) / reject. | 02, 03, 04 |
| 06 | [task-service.md](./06-task-service.md) | Extract `TaskService`: CRUD + column invariants + approve/reject. | 02, 04 |
| 07 | [orchestrator-and-tools.md](./07-orchestrator-and-tools.md) | Build `Orchestrator` + `ToolRegistry` + `session-bridge`. Translate agent tool calls into service ops; inject system events back into coordinator session. | 04, 05, 06 |
| 08 | [frontend.md](./08-frontend.md) | `ThreadView` + inline `PlanDraftCard`; consolidate `useTeams` / `useCoordination` hooks; Board card `source` badge. | 07 |
| 09 | [legacy-removal.md](./09-legacy-removal.md) | Drop legacy tables, delete `AgentTeam` types, shrink `BoardService` to facade or remove. | 03, 07, 08 |

## Dependency graph

```
01 ──▶ 02 ──▶ 03 ──┬──▶ 04 ──┬──▶ 05 ──┐
                   │         │         │
                   │         └──▶ 06 ──┤
                   │                   │
                   └───────────────────┴──▶ 07 ──▶ 08 ──▶ 09
```

## Rollout rules

- Each spec lands as one PR; green CI on `main` before the next starts.
- Specs 01–03 introduce new tables/types in parallel with legacy — zero runtime behavior change.
- Specs 04–07 add new services alongside `BoardService`; `BoardService` delegates where possible but is not yet deleted.
- Spec 08 flips the UI to the new endpoints.
- Spec 09 is the cleanup sweep; only runs after 08 has been in production for a while with no regressions.

## Non-goals (across all specs)

- Rewriting runner adapters (claude-cli / codex-acp / shell stay).
- Rewriting the WebSocket event bus mechanism (payloads change; transport doesn't).
- Changing the SQLite engine or persistence approach.
- Visual redesign (reuse shadcn baseline).
