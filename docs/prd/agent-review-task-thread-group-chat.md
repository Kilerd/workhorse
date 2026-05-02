# Description-Driven Agent Review and Task Thread Group Chat PRD

> Status: implementation PRD
> Scope: `packages/contracts`, `packages/server`, `packages/web`

## Summary

- Review responsibility is described in agent capabilities and workspace instructions, not encoded as a `reviewer` role.
- The coordinator chooses one or more review agents from the workspace roster based on descriptions, including cases such as technical review plus business review.
- Code exposes atomic review execution tools. It does not infer the reviewer, choose review count, or encode review policy.
- A task thread is the task group chat. It contains the user, coordinator, working agent, and any review agents.

## Product Semantics

- Workspace agents remain mounted as `coordinator` or `worker`.
- `AccountAgent.description` describes durable capability across workspaces.
- `WorkspaceAgent.workspaceDescription` describes the agent's concrete responsibilities in this workspace, such as coding, technical review, business review, planning, or release review.
- Coordinator sees the full agent roster and explicitly selects review agents by `workspaceAgentId`.
- `request_task_review` starts exactly one review run for one selected agent. Coordinator can call it multiple times with different agents and focuses.
- Task-thread group chat delivery requires explicit mentions:
  - `@coordinator` routes to the coordinator.
  - `@worker` and `@assignee` route to the assigned task worker.
  - `@agentName` and `@agentId` route to the matching mounted agent.
  - Messages without a mention remain ordinary group-chat messages.

## Implementation Requirements

- Keep `AgentRole = "coordinator" | "worker"`; do not add `reviewer`.
- `/api/tasks/{taskId}/review-request` accepts optional `reviewerAgentId` and `focus`.
  - `reviewerAgentId` is the agent selected by the coordinator.
  - `focus` is free text, e.g. `technical review` or `business review`.
  - If `reviewerAgentId` is omitted, the server only allows self-review from a coordinator/requester context.
- `request_task_review` tool accepts `{ taskId, reviewerAgentId?, focus? }`.
  - Tool description must tell the coordinator to choose agents from `list_agents` based on descriptions.
  - The server must not auto-pick a reviewer from role/name/description.
- Review runs clone the selected agent's runner config and replace the prompt with a read-only review prompt.
  - Claude review runs use `permissionMode: "plan"`.
  - Codex review runs use non-auto approval.
  - New metadata includes `manual_agent_review`, `reviewAgentId`, `reviewAgentName`, `reviewFocus`, and requester id.
  - Existing `manual_claude_review` runs remain compatible.
- Worker/reviewer run output is mirrored into task threads while retaining RunLog as the audit/debug layer.
- When a worker/reviewer final response lacks `@coordinator`, the system adds a completion status and notifies the coordinator as fallback.

## Test Plan

- Contracts:
  - No `reviewer` role appears in `AgentRole` schemas.
  - OpenAPI/api-client include `reviewerAgentId` and `focus` on review request bodies.
- Server:
  - `request_task_review` uses the explicit selected agent runner config.
  - Omitting `reviewerAgentId` only self-reviews from requester context; ambiguous HTTP calls are rejected.
  - Multiple review calls can target different agents/focuses without server-side reviewer selection.
  - Review prompt includes focus and selected agent context.
  - Run output mirrors into task thread and publishes `thread.message`.
  - Task-thread no-mention messages do not trigger agents; `@coordinator` does.
  - Completion fallback notifies coordinator.
- Web:
  - Role selectors only show coordinator/worker.
  - Workspace instructions copy explains coding/planning/review responsibilities.
  - Task review action asks coordinator to choose review agents.
  - ThreadView renders agent names and task-thread mention guidance.

## Assumptions

- Review capability is human-authored in descriptions.
- Coordinator reasoning chooses appropriate reviewers and review count.
- Code exposes execution primitives, not review policy.
- Historical RunLog entries are not backfilled into task threads.
