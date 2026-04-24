import type {
  AccountAgent,
  AgentSession,
  Message,
  ServerEvent,
  Thread,
  Workspace
} from "@workhorse/contracts";

import { createId } from "../lib/id.js";
import type { CoordinatorRunnerRegistry } from "../runners/coordinator-runner-registry.js";
import type {
  CoordinatorInputMessage,
  CoordinatorOutputChunk,
  CoordinatorRunHandle,
  CoordinatorRunOutcome
} from "../runners/session-bridge.js";
import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";
import { buildCoordinatorSystemPrompt } from "./coordinator-prompt.js";
import { PlanService } from "./plan-service.js";
import { TaskService } from "./task-service.js";
import { ThreadService } from "./thread-service.js";
import { ToolRegistry } from "./tool-registry.js";

export interface OrchestratorDeps {
  store: StateStore;
  events: EventBus;
  threads: ThreadService;
  plans: PlanService;
  tasks: TaskService;
  tools: ToolRegistry;
  runners: CoordinatorRunnerRegistry;
}

interface ActiveRun {
  threadId: string;
  runId: string;
  session: AgentSession;
  handle: CoordinatorRunHandle;
}

/**
 * Coordinator-session orchestrator.
 *
 * Responsibilities (PRD §2.1):
 *   1. One in-flight coordinator run per thread. The CAS-protected
 *      `coordinator_state` field is the source of truth; the in-memory
 *      `mutex` map only serializes the "check state + start runner"
 *      critical section against parallel onThreadMessage calls in the same
 *      process.
 *   2. Turn every pending user or system_event message on a thread into an
 *      append to the bound AgentSession.
 *   3. Route tool_use chunks from the runner into the ToolRegistry; stream
 *      assistant text back as kind='chat' messages.
 *   4. Subscribe to server events (`plan.updated`, `task.updated`) and
 *      inject `system_event` messages into the relevant coordinator thread
 *      so the agent sees them as turns rather than hard-coded transitions.
 */
export class Orchestrator {
  private readonly store: StateStore;
  private readonly events: EventBus;
  private readonly threads: ThreadService;
  private readonly plans: PlanService;
  private readonly tasks: TaskService;
  private readonly tools: ToolRegistry;
  private readonly runners: CoordinatorRunnerRegistry;

  private readonly mutex = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private unsubscribe?: () => void;

  public constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.threads = deps.threads;
    this.plans = deps.plans;
    this.tasks = deps.tasks;
    this.tools = deps.tools;
    this.runners = deps.runners;
  }

  public start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.events.subscribe((event) => {
      // System events are append-only side channels; keep them fire-and-forget
      // to avoid re-entrancy into the bus publisher.
      void this.onServerEvent(event);
    });
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  // ── Public entry points ──────────────────────────────────────────────────

  /**
   * Call when a user (or injected system_event) message was appended to a
   * coordinator thread. Idempotent: if a run is already in flight, the new
   * message is left in the pending queue and consumed on the next flush.
   */
  public async onThreadMessage(threadId: string): Promise<void> {
    await this.serialize(threadId, () => this.tryStartRun(threadId));
  }

  public async cancelCoordinatorRun(threadId: string): Promise<void> {
    const active = this.activeRuns.get(threadId);
    if (!active) return;
    await active.handle.cancel();
  }

  public async restartCoordinatorThread(
    threadId: string,
    agentId: string
  ): Promise<Thread> {
    await this.serialize(threadId, async () => {
      const active = this.activeRuns.get(threadId);
      if (active) {
        await active.handle.cancel();
        this.activeRuns.delete(threadId);
      }

      let thread = this.threads.requireThread(threadId);
      if (thread.kind !== "coordinator") {
        return;
      }

      thread = this.threads.setCoordinatorAgent(threadId, agentId);
      this.threads.resetSession(threadId);

      if (thread.coordinatorState !== "idle") {
        thread = this.threads.setCoordinatorState(threadId, "idle");
      }

      this.threads.appendMessage({
        threadId,
        sender: { type: "system" },
        kind: "system_event",
        payload: {
          kind: "coordinator.restart",
          agentId,
          text: "Coordinator restarted."
        }
      });

      await this.tryStartRun(threadId);
    });
    return this.threads.requireThread(threadId);
  }

  // ── Serialization helper ─────────────────────────────────────────────────

  private serialize(threadId: string, work: () => Promise<void>): Promise<void> {
    const prev = this.mutex.get(threadId) ?? Promise.resolve();
    const next = prev.then(work, work).catch((error) => {
      console.error(`[orchestrator] thread ${threadId} failed`, error);
    });
    this.mutex.set(threadId, next);
    // Clean up the slot once the tail settles so the map doesn't grow.
    next.finally(() => {
      if (this.mutex.get(threadId) === next) {
        this.mutex.delete(threadId);
      }
    });
    return next;
  }

  // ── Run lifecycle ────────────────────────────────────────────────────────

  private async tryStartRun(threadId: string): Promise<void> {
    const trigger = this.threads.enqueueCoordinatorTrigger(threadId);
    if (trigger.state === "running") {
      // Another turn owns the session; the pending message stays queued.
      return;
    }
    if (trigger.pending.length === 0) {
      // Nothing to do — no work to trigger a run.
      return;
    }

    const thread = this.threads.requireThread(threadId);
    if (thread.kind !== "coordinator") {
      // Only coordinator threads drive runs. Task / direct threads store
      // messages but do not trigger an agent loop here.
      return;
    }
    if (!thread.coordinatorAgentId) {
      console.warn(
        `[orchestrator] thread ${threadId} has no coordinatorAgentId; skipping`
      );
      return;
    }

    const workspace = this.getWorkspace(thread.workspaceId);
    if (!workspace) {
      console.warn(
        `[orchestrator] thread ${threadId} references missing workspace ${thread.workspaceId}`
      );
      return;
    }

    const runId = createId();
    this.threads.markMessagesConsumed(
      threadId,
      trigger.pending.map((m) => m.id),
      runId
    );

    // CAS into `running`. If it fails we lost a race and must return the
    // pending messages to the queue by clearing their consumed marker.
    try {
      this.threads.setCoordinatorState(threadId, "running");
    } catch (error) {
      // Best-effort rollback of the `consumed_by_run_id` marker. If this
      // fails too we log loudly — the next successful run will still see
      // them via listPendingMessages only once they're manually cleared.
      console.warn(
        `[orchestrator] failed to transition thread ${threadId} to running`,
        error
      );
      return;
    }

    const agent = this.store.getAgent(thread.coordinatorAgentId);
    if (!agent) {
      console.warn(
        `[orchestrator] thread ${threadId} references missing agent ${thread.coordinatorAgentId}`
      );
      // Best-effort: flip back to idle so the thread isn't stuck "running".
      try {
        this.threads.setCoordinatorState(threadId, "idle");
      } catch (error) {
        console.warn(
          `[orchestrator] failed to reset thread ${threadId} after missing agent`,
          error
        );
      }
      return;
    }

    const session = this.threads.getOrCreateSession(
      threadId,
      thread.coordinatorAgentId
    );

    const handle = await this.startRunner(
      runId,
      thread,
      workspace,
      agent,
      session,
      trigger.pending
    );

    this.activeRuns.set(threadId, { threadId, runId, session, handle });

    handle.onChunk((chunk) => {
      void this.handleChunk(threadId, session, chunk, handle);
    });
    handle.onFinish((outcome) => {
      // Re-serialize the finish path so it cannot overlap another
      // onThreadMessage transition.
      void this.serialize(threadId, () =>
        this.handleRunFinished(threadId, runId, outcome)
      );
    });
  }

  private async startRunner(
    runId: string,
    thread: Thread,
    workspace: Workspace,
    agent: AccountAgent,
    session: AgentSession,
    pending: Message[]
  ): Promise<CoordinatorRunHandle> {
    const agents = this.store.listWorkspaceAgents(workspace.id);
    const toolDefs = this.tools.list();
    const systemPrompt = buildCoordinatorSystemPrompt({
      workspace,
      thread,
      agents,
      tools: toolDefs
    });
    const appendMessages = pending.map((m) => toInputMessage(m));
    const runner = this.runners.resolve(agent);
    return runner.resumeOrStart({
      runId,
      threadId: thread.id,
      workspaceId: workspace.id,
      agentId: session.agentId,
      workspaceDir: workspace.rootPath,
      systemPrompt,
      sessionKey: session.runnerSessionKey,
      appendMessages,
      tools: toolDefs.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      }))
    });
  }

  private async handleChunk(
    threadId: string,
    session: AgentSession,
    chunk: CoordinatorOutputChunk,
    handle: CoordinatorRunHandle
  ): Promise<void> {
    if (chunk.type === "text") {
      this.threads.appendMessage({
        threadId,
        sender: { type: "agent", agentId: session.agentId },
        kind: "chat",
        payload: { text: chunk.text }
      });
      return;
    }
    if (chunk.type === "session_key") {
      try {
        this.threads.updateSessionRunnerKey(session.id, chunk.key);
      } catch (error) {
        console.warn(
          `[orchestrator] failed to persist runner session key for ${session.id}`,
          error
        );
      }
      return;
    }
    // Tool invocation — delegate to the registry and feed the result back.
    try {
      const result = await this.tools.invoke(chunk.name, chunk.input, {
        workspaceId: session.workspaceId,
        threadId,
        agentId: session.agentId
      });
      await handle.submitToolResult({
        toolUseId: chunk.toolUseId,
        result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await handle.submitToolResult({
        toolUseId: chunk.toolUseId,
        result: { error: { message } }
      });
    }
  }

  private async handleRunFinished(
    threadId: string,
    runId: string,
    outcome: CoordinatorRunOutcome
  ): Promise<void> {
    const active = this.activeRuns.get(threadId);
    if (active?.runId === runId) {
      this.activeRuns.delete(threadId);
    }
    // The finish outcome is logged by the runner adapter; the orchestrator
    // only cares about re-entry of the queue.
    void outcome;

    // Transition running → idle first. A follow-up trigger inspects pending
    // messages and flips back to running if there's more work.
    try {
      this.threads.setCoordinatorState(threadId, "idle");
    } catch (error) {
      console.warn(
        `[orchestrator] failed to reset thread ${threadId} to idle`,
        error
      );
      return;
    }

    // Flush any messages that arrived while the run was in flight.
    await this.tryStartRun(threadId);
  }

  // ── System-event injection ───────────────────────────────────────────────

  private async onServerEvent(event: ServerEvent): Promise<void> {
    if (event.type === "thread.message") {
      // Only user-posted messages trigger a coordinator turn here. Agent
      // messages come from our own runs and would cause re-entry; system
      // messages arrive via dedicated injection below.
      if (event.message.sender.type === "user") {
        await this.onThreadMessage(event.threadId);
      }
      return;
    }

    if (event.type === "plan.updated") {
      this.injectSystemEvent(event.plan.threadId, {
        kind: "plan.updated",
        planId: event.planId,
        status: event.plan.status
      });
      await this.onThreadMessage(event.plan.threadId);
      return;
    }

    if (event.type === "task.updated" && event.task) {
      const planId = event.task.planId;
      if (!planId) return;
      const plan = this.plans.getPlan(planId);
      if (!plan) return;
      this.injectSystemEvent(plan.threadId, {
        kind: "task.updated",
        action: event.action,
        taskId: event.taskId,
        column: event.task.column,
        rejected: event.task.rejected ?? false
      });
      await this.onThreadMessage(plan.threadId);
      return;
    }
  }

  private injectSystemEvent(threadId: string, payload: unknown): void {
    try {
      this.threads.appendMessage({
        threadId,
        sender: { type: "system" },
        kind: "system_event",
        payload
      });
    } catch (error) {
      // The source thread may be archived or deleted; drop the event.
      console.warn(
        `[orchestrator] skipping system_event for thread ${threadId}`,
        error
      );
    }
  }

  private getWorkspace(workspaceId: string): Workspace | undefined {
    return this.store.listWorkspaces().find((w) => w.id === workspaceId);
  }
}

function toInputMessage(message: Message): CoordinatorInputMessage {
  const role = message.sender.type === "user" ? "user" : "system";
  const content = renderPayload(message);
  return { role, content };
}

function renderPayload(message: Message): string {
  const payload = message.payload;
  if (payload && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
  }
  // For anything non-chat (system_event, plan_draft, ...) hand the JSON over
  // so the agent can parse structured payloads verbatim.
  return JSON.stringify({ kind: message.kind, payload });
}
