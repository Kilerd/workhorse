# Phase 2 PR2: Coordinator Flow + EventBus Messages

## Goal

Prepare the coordinator execution layer for Agent Team tasks:

- build the coordinator prompt with explicit system/user boundaries
- parse coordinator-produced JSON subtasks
- define and normalize Team EventBus payloads
- inject prior team messages into subtask prompts

## Delivered In This PR

- `team.agent.message` and `team.task.created` event contracts in `@workhorse/contracts`
- `team-coordinator-service.ts` with pure helpers for:
  - coordinator prompt construction
  - coordinator JSON subtask parsing
  - team message payload truncation
  - subtask prompt injection
  - EventBus event object creation
- unit tests for prompt building, parsing, truncation, and event creation

## Deferred Until PR1 Lands

This PR intentionally avoids schema-coupled integration because PR1 owns the Team data model:

- `teams` / `team_agents` / `team_messages` persistence
- `task.teamId` / `task.parentTaskId` / `task.teamAgentId`
- CRUD and read APIs for those resources

Once PR1 merges, PR2 can wire these helpers into:

1. team task start interception
2. coordinator run completion callback
3. `team_messages` persistence
4. EventBus publishing for team activity
5. subtask creation using real team-agent assignments

## Open Integration Notes

- Coordinator JSON parse failure should move the parent task to `review`, not `failed`.
- Subtask creation should remain synchronous inside the coordinator completion callback to avoid race conditions.
- Team message payloads are capped at 10KB.
- Coordinator itself is part of the parent task and does not count as a child task for PR3 aggregation.
