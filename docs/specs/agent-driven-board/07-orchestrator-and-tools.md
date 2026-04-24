# Spec 07 — Orchestrator + ToolRegistry + session-bridge

## Goal

This is the keystone spec. Build the three pieces that turn the new services into an agent-driven system:

1. **`session-bridge`** in the runner layer — adds `resumeOrStart(sessionKey, msgs[]) → Run` to each runner adapter. Coordinator runs reuse the agent's chat session instead of rebuilding context.
2. **`ToolRegistry`** — the set of atomic tools exposed to agents (see PRD §3.2). Each tool has a JSON schema + a handler that calls into TaskService / PlanService / ThreadService.
3. **`Orchestrator`** — per-thread coordinator serial queue; translates coordinator tool calls into service ops; injects system events (task finished, plan approved, user rejected) back into the coordinator session as `system_event` messages.

After this spec, a user message in `#coordinator` → coordinator runs → tool calls drive the board. No more `BoardService` workflow code in the hot path for new threads.

## Prerequisites

- Specs 04, 05, 06 all landed.

## Scope

### Runner session bridge

- `packages/server/src/runners/session-bridge.ts` — new.
- Modify existing adapters:
  - `packages/server/src/runners/claude-cli-runner.ts` — support `--resume <sessionId>` when `runnerSessionKey` is present.
  - `packages/server/src/codex-acp-runner.ts` — reuse existing ACP session handle when present.
  - `packages/server/src/runners/shell-runner.ts` — ignore `sessionKey` (no session support); logs a warning if called with one.
- Update `Runner` interface to include:
  ```ts
  resumeOrStart(input: {
    sessionKey?: string;     // undefined => start new
    appendMessages: Array<{ role: "user" | "system"; content: string }>;
    // ... existing fields: workspaceDir, runId, ...
  }): Promise<Run>;
  ```
- On successful start, the adapter writes back the runner's session id (claude returns one in its JSONL header; codex has an ACP session id) into the `AgentSession.runner_session_key` via `ThreadService.updateSessionRunnerKey`.

### ToolRegistry

- `packages/server/src/services/tool-registry.ts` — new.
- Shape:
  ```ts
  interface ToolHandlerCtx {
    workspaceId: string;
    threadId: string;
    agentId: string; // the agent currently calling
  }

  interface ToolDefinition<I, O> {
    name: string;
    description: string;
    inputSchema: JSONSchema;
    handler: (input: I, ctx: ToolHandlerCtx) => Promise<O>;
  }

  class ToolRegistry {
    register(def: ToolDefinition<any, any>): void;
    list(): ToolDefinition[];
    invoke(name: string, input: unknown, ctx: ToolHandlerCtx): Promise<unknown>;
  }
  ```
- Register the tools from PRD §3.2:
  - Task: `create_task`, `move_task`, `start_task_run`, `cancel_task_run`, `annotate_task`, `decide_task`.
  - Plan: `propose_plan`, `supersede_plan`.
  - Thread/Message: `post_message`, `request_user_input`.
  - Agent: `list_agents` (returns two-layer descriptions), `spawn_agent`.
  - Git: `open_pr`, `get_diff`.
  - Read-only: `get_workspace_state`, `get_task`.
- Each handler is a thin wrapper: validate input → delegate to TaskService/PlanService/ThreadService/PrService. No business logic in handlers themselves.

### Orchestrator

- `packages/server/src/services/orchestrator.ts` — new.
- Responsibilities (from PRD §2.1 diagram):
  1. **Thread ↔ AgentSession binding & resume.**
     - On `onThreadMessage(threadId, msg)` in a coordinator thread: call `ThreadService.enqueueCoordinatorTrigger`. If returned state is `running`, return (message already queued via `consumed_by_run_id = NULL`). Otherwise start a run:
       - Resolve AgentSession via `ThreadService.getOrCreateSession(threadId, thread.coordinatorAgentId)`.
       - Call `runner.resumeOrStart({ sessionKey: session.runner_session_key, appendMessages: [...pendingBatch] })`.
       - Mark pending messages as `consumed_by_run_id = run.id`.
       - Set `thread.coordinator_state = 'running'`.
  2. **Per-thread serial queue.** Only one in-flight coordinator run per thread. Implemented via the `coordinator_state` field + an in-memory per-thread mutex for the "transition + start runner" critical section.
  3. **Output parsing.** Subscribe to the run's stream. For each tool_use chunk, call `ToolRegistry.invoke`. For each assistant text chunk, append a `kind='chat'` message via ThreadService.
  4. **Run finish handling.**
     - Check `ThreadService.listPendingMessages(threadId)`. If non-empty → batch-flush into a new run (transition `running → running` by starting the next run before publishing `idle`). If empty → transition to `idle`.
  5. **System-event injection.** Subscribe to:
     - `task.updated` (column change on tasks in a coordinator-owned plan),
     - `plan.updated` (approve/reject from user),
     - Worker run finish events.
     For each relevant event, append a `kind='system_event'` message to the owning coordinator thread via `ThreadService.appendMessage`. This triggers the same `onThreadMessage` path — events become turns in the coordinator session, not hard-coded state machine transitions.

- **Cancellation.** `cancelCoordinatorRun(threadId)`: SIGTERM the runner; on runner exit, follow the finish path. Pending messages accumulate for the next user-initiated run (per PRD §4.5.6).

### System prompt assembly

- `packages/server/src/services/coordinator-prompt.ts` — new module; exports `buildCoordinatorSystemPrompt(workspace, thread)`:
  - Workspace setting text (PR strategy, auto-approve, review preference) — inserted verbatim.
  - Full list of workspace agents with **both** descriptions (`accountAgent.description` + `workspaceAgent.description?`) so the coordinator can decide delegation targets.
  - The ToolRegistry schemas (rendered as tool definitions the runner understands; for Claude CLI that's its tool-use protocol).
- This module replaces the current `team-coordinator-service.ts::buildCoordinatorPrompt` / `buildSubtaskPrompt` helpers. The old helpers stay until Spec 09 for BoardService callers.

## Tests

- **Per-thread serial queue**: fire 5 `onThreadMessage` calls in parallel → exactly 1 run starts; remaining 4 messages are in `consumed_by_run_id=NULL` until the first finishes; then the next run consumes all 4 in one batch.
- **Tool call routing**: mock runner emits `tool_use: propose_plan(...)` → `PlanService.propose` called with expected args.
- **System event injection**: approve a plan → a `system_event` message appears in the coordinator thread → triggers a new coordinator run carrying that event.
- **Resume**: second run on same thread calls `runner.resumeOrStart` with the previously stored `runnerSessionKey`.
- **No business logic leakage**: a coordinator output with only `reply(text)` → no tasks/plans created; only a chat message in the thread.

## Rollout note

`BoardService` stays as the handler for legacy `teams/*` endpoints. New `#coordinator` threads go through Orchestrator. The two systems do not cross-talk.

## Out of scope

- Deleting `BoardService` / `team-coordinator-service.ts` / `task-scheduler.ts` (Spec 09).
- UI changes (Spec 08).
- Cron / scheduled coordinator triggers (not in this refactor).
