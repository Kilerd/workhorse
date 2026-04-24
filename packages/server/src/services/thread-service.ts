import type {
  AgentSession,
  CoordinatorState,
  Message,
  MessageKind,
  MessageSender,
  Thread,
  ThreadKind
} from "@workhorse/contracts";

import { AppError, ensure } from "../lib/errors.js";
import { createId } from "../lib/id.js";
import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";

export interface CreateThreadInput {
  workspaceId: string;
  kind: ThreadKind;
  taskId?: string;
  coordinatorAgentId?: string;
}

export interface AppendMessageInput {
  threadId: string;
  sender: MessageSender;
  kind: MessageKind;
  payload: unknown;
}

export interface ListMessagesOptions {
  after?: string;
  limit?: number;
}

export interface EnqueueCoordinatorTriggerResult {
  state: CoordinatorState;
  pending: Message[];
}

function readTextPayload(payload: unknown): string {
  if (payload && typeof payload === "object" && "text" in payload) {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  if (typeof payload === "string") return payload;
  return "";
}

function readObjectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

// Allowed coordinator state transitions. Keeping them in a table makes the
// rule table trivially auditable and lets the validator share the same source
// of truth with tests.
const ALLOWED_TRANSITIONS: ReadonlyMap<CoordinatorState, ReadonlySet<CoordinatorState>> =
  new Map<CoordinatorState, ReadonlySet<CoordinatorState>>([
    ["idle", new Set<CoordinatorState>(["queued", "running"])],
    ["queued", new Set<CoordinatorState>(["running", "idle"])],
    ["running", new Set<CoordinatorState>(["idle"])]
  ]);

export class ThreadService {
  public constructor(
    private readonly store: StateStore,
    private readonly events: EventBus
  ) {}

  // ── Thread lifecycle ──────────────────────────────────────────────────────

  public createThread(input: CreateThreadInput): Thread {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: createId(),
      workspaceId: input.workspaceId,
      kind: input.kind,
      taskId: input.taskId,
      coordinatorAgentId: input.coordinatorAgentId,
      coordinatorState: "idle",
      createdAt: now
    };
    this.store.insertThread(thread);
    this.events.publish({
      type: "thread.updated",
      action: "created",
      threadId: thread.id,
      thread
    });
    return thread;
  }

  public getThread(id: string): Thread | undefined {
    return this.store.getThread(id) ?? undefined;
  }

  public requireThread(id: string): Thread {
    return ensure(
      this.getThread(id),
      404,
      "THREAD_NOT_FOUND",
      `Thread ${id} not found`
    );
  }

  public listThreads(workspaceId: string): Thread[] {
    return this.store.listThreadsByWorkspace(workspaceId);
  }

  public archiveThread(id: string): Thread {
    const existing = this.requireThread(id);
    const archivedAt = existing.archivedAt ?? new Date().toISOString();
    const updated = this.store.archiveThread(id, archivedAt);
    const result = ensure(
      updated ?? undefined,
      404,
      "THREAD_NOT_FOUND",
      `Thread ${id} not found`
    );
    this.events.publish({
      type: "thread.updated",
      action: "archived",
      threadId: result.id,
      thread: result
    });
    return result;
  }

  public setCoordinatorAgent(threadId: string, agentId: string): Thread {
    const thread = this.requireThread(threadId);
    if (thread.kind !== "coordinator") {
      throw new AppError(
        409,
        "THREAD_NOT_COORDINATOR",
        `Thread ${threadId} is not a coordinator thread`
      );
    }
    if (thread.coordinatorAgentId === agentId) {
      return thread;
    }
    const updated = this.store.updateThreadCoordinatorAgent(threadId, agentId);
    const result = ensure(
      updated ?? undefined,
      404,
      "THREAD_NOT_FOUND",
      `Thread ${threadId} not found`
    );
    this.events.publish({
      type: "thread.updated",
      action: "updated",
      threadId: result.id,
      thread: result
    });
    return result;
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  public appendMessage(input: AppendMessageInput): Message {
    const thread = this.requireThread(input.threadId);
    if (thread.archivedAt) {
      throw new AppError(
        409,
        "THREAD_ARCHIVED",
        `Thread ${thread.id} is archived`
      );
    }

    const message: Message = {
      id: createId(),
      threadId: thread.id,
      sender: input.sender,
      kind: input.kind,
      payload: input.payload,
      createdAt: new Date().toISOString()
    };
    this.store.insertMessage(message);
    this.events.publish({
      type: "thread.message",
      threadId: thread.id,
      message
    });
    return message;
  }

  public appendToMessageText(messageId: string, text: string): Message {
    const existing = ensure(
      this.store.getMessage(messageId) ?? undefined,
      404,
      "MESSAGE_NOT_FOUND",
      `Message ${messageId} not found`
    );

    if (existing.kind !== "chat") {
      throw new AppError(
        409,
        "MESSAGE_NOT_CHAT",
        `Message ${messageId} is not a chat message`
      );
    }

    const updated = this.store.updateMessagePayload(messageId, {
      ...readObjectPayload(existing.payload),
      text: `${readTextPayload(existing.payload)}${text}`
    });
    const result = ensure(
      updated ?? undefined,
      404,
      "MESSAGE_NOT_FOUND",
      `Message ${messageId} not found`
    );
    this.events.publish({
      type: "thread.message",
      threadId: result.threadId,
      message: result
    });
    return result;
  }

  public listMessages(threadId: string, opts?: ListMessagesOptions): Message[] {
    return this.store.listMessages(threadId, opts ?? {});
  }

  public listPendingMessages(threadId: string): Message[] {
    return this.store.listPendingCoordinatorMessages(threadId);
  }

  public markMessagesConsumed(
    threadId: string,
    messageIds: string[],
    runId: string
  ): void {
    // threadId is passed for future scoping/validation; current store API is
    // keyed by message id (which is globally unique).
    void threadId;
    this.store.markMessagesConsumed(messageIds, runId);
  }

  // ── Coordinator state machine ─────────────────────────────────────────────

  public setCoordinatorState(
    threadId: string,
    next: CoordinatorState
  ): Thread {
    const thread = this.requireThread(threadId);
    if (thread.coordinatorState === next) {
      return thread;
    }
    const allowed = ALLOWED_TRANSITIONS.get(thread.coordinatorState);
    if (!allowed?.has(next)) {
      throw new AppError(
        409,
        "COORDINATOR_STATE_INVALID_TRANSITION",
        `Invalid coordinator state transition ${thread.coordinatorState} → ${next}`
      );
    }
    const updated = this.store.transitionCoordinatorState(
      threadId,
      thread.coordinatorState,
      next
    );
    if (!updated) {
      // CAS lost — another writer changed state between the read and the write.
      throw new AppError(
        409,
        "COORDINATOR_STATE_CONFLICT",
        `Coordinator state for ${threadId} changed concurrently`
      );
    }
    this.events.publish({
      type: "thread.updated",
      action: "updated",
      threadId: updated.id,
      thread: updated
    });
    return updated;
  }

  public enqueueCoordinatorTrigger(
    threadId: string
  ): EnqueueCoordinatorTriggerResult {
    const thread = this.requireThread(threadId);
    const pending = this.listPendingMessages(threadId);
    return { state: thread.coordinatorState, pending };
  }

  // ── Agent sessions ────────────────────────────────────────────────────────

  public getOrCreateSession(threadId: string, agentId: string): AgentSession {
    const existing = this.store.getAgentSessionByThread(threadId);
    if (existing) {
      if (existing.agentId !== agentId) {
        throw new AppError(
          409,
          "AGENT_SESSION_MISMATCH",
          `Thread ${threadId} is bound to agent ${existing.agentId}, not ${agentId}`
        );
      }
      return existing;
    }
    const thread = this.requireThread(threadId);
    const session: AgentSession = {
      id: createId(),
      workspaceId: thread.workspaceId,
      agentId,
      threadId,
      createdAt: new Date().toISOString()
    };
    this.store.insertAgentSession(session);
    return session;
  }

  public resetSession(threadId: string): void {
    this.store.deleteAgentSessionByThread(threadId);
  }

  public updateSessionRunnerKey(
    sessionId: string,
    runnerSessionKey: string
  ): AgentSession {
    const updated = this.store.updateAgentSessionRunnerKey(
      sessionId,
      runnerSessionKey
    );
    return ensure(
      updated ?? undefined,
      404,
      "AGENT_SESSION_NOT_FOUND",
      `Agent session ${sessionId} not found`
    );
  }
}
