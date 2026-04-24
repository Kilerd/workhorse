# Spec 04 — ThreadService: CRUD + message append + session state machine

## Goal

Introduce `ThreadService` as the single entry point for Thread / Message / AgentSession operations. This service owns:

1. Thread CRUD (create `#coordinator` / task / direct threads).
2. Message append + WS broadcast (`thread.message`).
3. `coordinatorState` state machine (`idle` / `queued` / `running`) per Spec §4.5 of the PRD.
4. AgentSession lifecycle — one session per thread, resolved on demand when a coordinator run starts.

`ThreadService` does **not** start Runner processes or parse coordinator output — that's Orchestrator's job (Spec 07). This service is a persistence + state gateway.

## Prerequisites

- Spec 02 (types) + Spec 03 (migration so new tables have legacy data mirrored).

## Scope

- `packages/server/src/services/thread-service.ts` — new.
- `packages/server/src/services/thread-service.test.ts` — new.
- `packages/server/src/app.ts` — mount new routes.
- No changes to `BoardService`; it keeps running in parallel.

## API surface

```ts
class ThreadService {
  // ── Thread lifecycle ────────────────────────────────
  createThread(input: {
    workspaceId: string;
    kind: ThreadKind;
    taskId?: string;
    coordinatorAgentId?: string;
  }): Thread;

  getThread(id: string): Thread | undefined;
  listThreads(workspaceId: string): Thread[];

  archiveThread(id: string): Thread;

  // ── Messages ────────────────────────────────────────
  appendMessage(input: {
    threadId: string;
    sender: MessageSender;
    kind: MessageKind;
    payload: unknown;
  }): Message; // persists + broadcasts WS `thread.message`

  listMessages(threadId: string, opts?: { after?: string; limit?: number }): Message[];

  // Used by Orchestrator to mark a batch of user messages as consumed by a run.
  markMessagesConsumed(threadId: string, messageIds: string[], runId: string): void;

  listPendingMessages(threadId: string): Message[]; // consumed_by_run_id IS NULL,
                                                    // sender.type == "user"

  // ── Coordinator state machine ───────────────────────
  // Atomic state transitions; throws on invalid transition.
  setCoordinatorState(threadId: string, next: CoordinatorState): Thread;

  // Convenience: CAS idle→running or idle→queued based on current.
  // Returns the new state + the messages that should be batched into the next run.
  enqueueCoordinatorTrigger(threadId: string): {
    state: CoordinatorState;
    pending: Message[];
  };

  // ── Agent sessions ──────────────────────────────────
  getOrCreateSession(threadId: string, agentId: string): AgentSession;
  updateSessionRunnerKey(sessionId: string, runnerSessionKey: string): AgentSession;
}
```

## State machine invariants

- `idle` → `running` : allowed only when no in-flight coordinator run exists. Orchestrator calls this before starting a run.
- `idle`/`queued` → `running` : Orchestrator, after flushing queued messages.
- `running` → `idle` : Orchestrator after a run finishes with no pending messages.
- `running` → `queued` : NOT a valid transition (queued only means "waiting to start"). Instead, `running` stays `running` while pending messages accumulate; Orchestrator decides on finish.
- `queued` → `running` : Orchestrator flushes.

The state machine is enforced by a `CHECK` in `setCoordinatorState` — invalid transitions throw.

## REST routes (mount in `app.ts`)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/workspaces/:wsId/threads` | — | `Thread[]` |
| POST | `/api/workspaces/:wsId/threads` | `{ kind, taskId?, coordinatorAgentId? }` | `Thread` |
| GET | `/api/threads/:id/messages?after=&limit=` | — | `Message[]` |
| POST | `/api/threads/:id/messages` | `{ content: string; kind?: "chat" }` | `Message` |

The `POST /messages` route appends a user message and, if the thread is a coordinator thread, calls `Orchestrator.onThreadMessage(threadId, message)` (Spec 07). In this spec, that hook is a no-op stub — Orchestrator wires itself up in Spec 07.

## WebSocket

- Emit `{ type: "thread.message", threadId, message }` on every `appendMessage`.
- Emit `{ type: "thread.updated", threadId, thread }` on state changes + archive.

## Tests

- Create a thread → append 3 messages → assert ordering + WS broadcast counts.
- `enqueueCoordinatorTrigger` transitions:
  - idle + no pending → idle (nothing to run).
  - idle + 1 user message → state advances to running via the caller (Orchestrator owns the actual `running` write); spec-level test: returns pending=[msg].
  - running + new user msg → state stays running; new msg is in pending on next call.
- `markMessagesConsumed` sets `consumed_by_run_id` atomically and pending list shrinks accordingly.
- `getOrCreateSession` is idempotent per (threadId, agentId) pair; second call returns same row.

## Out of scope

- Actually starting a Runner (Spec 07).
- Parsing coordinator output / handling tool calls (Spec 07).
- Migrating legacy `BoardService.publishTeamMessage` callers (Spec 09).
