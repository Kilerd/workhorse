# Phase 2 PR4: Team UI

## Goal

Add the first frontend surface for Agent Teams so users can:

- create and edit teams
- assign a task to a team from the create-task modal
- distinguish team tasks on the board
- inspect coordinator/subtask execution context via `team_messages`

PR4 depends on the merged backend work from PR1-PR3.

## Scope

### Team management

- Add a Team management modal opened from the sidebar
- Show a team list with summary cards
- Support create, edit, and delete flows
- Validate that each team has exactly one coordinator
- Keep the initial PR strategy UI constrained to `independent`

### Create task modal

- Add optional Team selection
- Filter teams by the selected workspace
- When a team is selected, auto-fill the task runner from the coordinator agent
- Persist `teamId` through `CreateTaskBody`
- On the server, validate that the selected team belongs to the chosen workspace
- On the server, canonicalize the created task runner to the coordinator runner config

### Board enhancements

- Show a Team marker on team tasks
- Show agent-count metadata on parent team tasks
- Show subtask/team-agent metadata on child team tasks
- Expand selected parent team tasks with a compact subtask list and status view

### Task details

- Reuse `TaskDetailsPanel` for team tasks and subtasks
- Add team context summary
- Add a `TeamMessageFeed` for the current parent-task thread
- Render `status` messages as labeled entries
- Render `artifact` messages as structured, collapsible payload views
- Keep the human reply box visible but disabled with `Coming soon`

### Data layer

- Add React Query hooks:
  - `useTeams`
  - `useTeam`
  - `useTeamMessages`
- Add API client methods for:
  - list/create/get/update/delete team
  - list team messages
- Invalidate Team queries from websocket events:
  - `team.updated`
  - `team.agent.message`
  - `team.task.created`

## Non-goals

- Human-to-agent team replies
- Rich PR strategy UI beyond `independent`
- Task reassignment/edit flows for `teamId`
- Dedicated team dashboard routes outside the existing board/task-detail shell

## Validation

- `npm run generate:client`
- `npm run build --workspace @workhorse/server`
- `npm run build --workspace @workhorse/web`
- `npm run test --workspace @workhorse/contracts`
- `npm run test --workspace @workhorse/server -- team-execution.test.ts`
- `npm run test --workspace @workhorse/web`
