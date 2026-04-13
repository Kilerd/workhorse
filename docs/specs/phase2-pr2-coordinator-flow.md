# Phase 2 PR2: Coordinator Flow + EventBus Messages

## Goal

Implement the Team coordinator execution loop for Agent Team tasks:

- intercept parent team-task starts and route them through the configured coordinator agent
- parse coordinator-produced JSON subtasks
- persist and publish team activity via `team.agent.message` / `team.task.created`
- inject team context and historical messages into child subtask prompts

## Delivered In This PR

- `team.agent.message` and `team.task.created` event contracts in `@workhorse/contracts`
- `team-coordinator-service.ts` helpers for:
  - coordinator prompt construction
  - coordinator JSON subtask parsing
  - team message payload truncation
  - subtask prompt injection
  - EventBus event object creation
- `BoardService` runtime integration:
  - parent tasks with `teamId` now start with the team coordinator's runner config
  - child tasks with `parentTaskId` + `teamAgentId` now start with injected team context
  - successful coordinator runs synchronously create subtask tasks and dependencies
  - successful coordinator runs publish a coordinator summary as both:
    - persisted `team_messages` row
    - `team.agent.message` websocket event
  - successful coordinator runs publish `team.task.created`
  - parent tasks stay in `running` after delegation instead of immediately dropping to `review`
  - malformed coordinator output appends a system parse-error log and leaves the parent task in `review`
- schema / API extensions needed by PR2:
  - `team_messages.parentTaskId`
  - `team_messages.messageType`
  - `GET /api/teams/:teamId/messages?parentTaskId=...`
- tests:
  - unit tests for prompt building, parsing, truncation, and event creation
  - integration tests for coordinator -> subtasks -> message persistence/prompt injection
  - SQLite persistence tests for `parentTaskId` filtering and `messageType`

## Still Deferred

This PR intentionally stops short of the PR3 aggregation layer:

- independent team branch naming strategy (`team/{teamId}/{subtask-slug}`)
- automatic artifact/status messages on child completion
- “all child tasks done -> parent review” aggregation
- partial-failure parent blocking semantics

## Integration Notes

- Coordinator JSON parse failure moves the parent task to `review`, not `failed`.
- Subtask creation remains synchronous inside the coordinator completion hook to avoid race conditions.
- Team message payloads are capped at 10KB before persistence and websocket publish.
- Coordinator itself is part of the parent task and does not count as a child task for PR3 aggregation.
