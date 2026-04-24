import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccountAgent, ServerEvent, Workspace } from "@workhorse/contracts";

import { CoordinatorRunnerRegistry } from "../runners/coordinator-runner-registry.js";
import type {
  CoordinatorOutputChunk,
  CoordinatorRunHandle,
  CoordinatorRunInput,
  CoordinatorRunOutcome,
  CoordinatorRunner
} from "../runners/session-bridge.js";
import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";
import { Orchestrator } from "./orchestrator.js";
import { PlanService } from "./plan-service.js";
import { TaskService } from "./task-service.js";
import { ThreadService } from "./thread-service.js";
import { buildDefaultToolRegistry, ToolRegistry } from "./tool-registry.js";

class FakeHandle implements CoordinatorRunHandle {
  public readonly runId: string;
  public readonly input: CoordinatorRunInput;
  public chunkHandlers: Array<(c: CoordinatorOutputChunk) => void> = [];
  public finishHandlers: Array<(o: CoordinatorRunOutcome) => void> = [];
  public toolResults: Array<{ toolUseId: string; result: unknown }> = [];
  public canceled = false;

  public constructor(input: CoordinatorRunInput) {
    this.runId = input.runId;
    this.input = input;
  }

  public onChunk(handler: (c: CoordinatorOutputChunk) => void): () => void {
    this.chunkHandlers.push(handler);
    return () => {
      this.chunkHandlers = this.chunkHandlers.filter((h) => h !== handler);
    };
  }

  public onFinish(handler: (o: CoordinatorRunOutcome) => void): () => void {
    this.finishHandlers.push(handler);
    return () => {
      this.finishHandlers = this.finishHandlers.filter((h) => h !== handler);
    };
  }

  public async submitToolResult(input: {
    toolUseId: string;
    result: unknown;
  }): Promise<void> {
    this.toolResults.push(input);
  }

  public async cancel(): Promise<void> {
    this.canceled = true;
  }

  public emitChunk(chunk: CoordinatorOutputChunk): void {
    for (const h of this.chunkHandlers) h(chunk);
  }

  public async finish(
    outcome: CoordinatorRunOutcome = { status: "succeeded" }
  ): Promise<void> {
    for (const h of this.finishHandlers) h(outcome);
    // Let microtasks flush (the orchestrator schedules the finish path).
    await new Promise((resolve) => setImmediate(resolve));
  }
}

class FakeRunner implements CoordinatorRunner {
  public readonly handles: FakeHandle[] = [];
  private deferredStart: Array<() => void> = [];
  private holdStarts = false;

  public pause(): void {
    this.holdStarts = true;
  }

  public resume(): void {
    this.holdStarts = false;
    const pending = this.deferredStart.splice(0);
    for (const fn of pending) fn();
  }

  public async resumeOrStart(
    input: CoordinatorRunInput
  ): Promise<CoordinatorRunHandle> {
    if (this.holdStarts) {
      await new Promise<void>((resolve) => {
        this.deferredStart.push(resolve);
      });
    }
    const handle = new FakeHandle(input);
    this.handles.push(handle);
    return handle;
  }
}

function makeWorkspace(id = "ws-1"): Workspace {
  const now = new Date().toISOString();
  return {
    id,
    name: "Test workspace",
    rootPath: "/tmp/test",
    isGitRepo: false,
    codexSettings: {
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write"
    },
    createdAt: now,
    updatedAt: now
  };
}

interface Harness {
  store: StateStore;
  events: EventBus;
  threads: ThreadService;
  plans: PlanService;
  tasks: TaskService;
  tools: ToolRegistry;
  runner: FakeRunner;
  orchestrator: Orchestrator;
  workspace: Workspace;
  published: ServerEvent[];
  threadId: string;
}

async function setup(): Promise<Harness> {
  const store = new StateStore(":memory:");
  await store.load();
  const workspace = makeWorkspace();
  store.setWorkspaces([workspace]);
  const agent: AccountAgent = {
    id: "wa-1",
    name: "coordinator-agent",
    description: "fake coordinator",
    runnerConfig: { type: "shell", command: "/bin/true" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.createAgent(agent);
  await store.save();

  const published: ServerEvent[] = [];
  const events = new EventBus();
  const origPublish = events.publish.bind(events);
  events.publish = (event: ServerEvent): void => {
    published.push(event);
    origPublish(event);
  };

  const threads = new ThreadService(store, events);
  const plans = new PlanService(store, events);
  const tasks = new TaskService(store, threads, events);
  const tools = buildDefaultToolRegistry({ store, tasks, plans, threads });
  const runner = new FakeRunner();
  const runners = new CoordinatorRunnerRegistry(runner);
  const orchestrator = new Orchestrator({
    store,
    events,
    threads,
    plans,
    tasks,
    tools,
    runners
  });
  orchestrator.start();

  const thread = threads.createThread({
    workspaceId: workspace.id,
    kind: "coordinator",
    coordinatorAgentId: "wa-1"
  });

  return {
    store,
    events,
    threads,
    plans,
    tasks,
    tools,
    runner,
    orchestrator,
    workspace,
    published,
    threadId: thread.id
  };
}

describe("Orchestrator — per-thread serial queue", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  afterEach(() => {
    harness.orchestrator.stop();
  });

  it("starts at most one run; extra triggers wait for the first to finish", async () => {
    const { threads, runner, orchestrator, threadId } = harness;
    runner.pause();

    // Seed 5 user messages.
    const msgs: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const m = threads.appendMessage({
        threadId,
        sender: { type: "user" },
        kind: "chat",
        payload: { text: `msg-${i}` }
      });
      msgs.push(m.id);
    }

    // Fire all triggers in parallel.
    const triggers = Promise.all(
      msgs.map(() => orchestrator.onThreadMessage(threadId))
    );
    runner.resume();
    await triggers;

    // Exactly one run was started so far; it consumed all pending messages.
    expect(runner.handles).toHaveLength(1);
    const firstHandle = runner.handles[0]!;
    expect(firstHandle.input.appendMessages).toHaveLength(5);

    // No further messages arrived while the run was in flight, so finishing
    // it leaves the thread idle and starts no additional runs.
    await firstHandle.finish();
    expect(runner.handles).toHaveLength(1);
    expect(threads.requireThread(threadId).coordinatorState).toBe("idle");
  });

  it("batches messages that arrive during an in-flight run into the next run", async () => {
    const { threads, runner, orchestrator, threadId } = harness;

    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "first" }
    });
    await orchestrator.onThreadMessage(threadId);
    expect(runner.handles).toHaveLength(1);
    const firstHandle = runner.handles[0]!;

    // New messages arrive while run 1 is running.
    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "second" }
    });
    await orchestrator.onThreadMessage(threadId);
    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "third" }
    });
    await orchestrator.onThreadMessage(threadId);
    expect(runner.handles).toHaveLength(1);

    await firstHandle.finish();

    expect(runner.handles).toHaveLength(2);
    const secondHandle = runner.handles[1]!;
    const contents = secondHandle.input.appendMessages.map((m) => m.content);
    expect(contents).toEqual(["second", "third"]);
  });
});

describe("Orchestrator — tool routing", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  afterEach(() => {
    harness.orchestrator.stop();
  });

  it("restarts a coordinator thread without appending a synthetic turn", async () => {
    const { threads, runner, orchestrator, threadId } = harness;

    const restarted = await orchestrator.restartCoordinatorThread(threadId, "wa-1");
    const messages = threads.listMessages(threadId);

    expect(restarted.coordinatorAgentId).toBe("wa-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      sender: { type: "system" },
      kind: "status",
      payload: {
        kind: "coordinator_restart",
        event: "Restart"
      }
    });
    expect(threads.listPendingMessages(threadId)).toHaveLength(0);
    expect(runner.handles).toHaveLength(0);
  });

  it("routes tool_use chunks into the ToolRegistry and replies with results", async () => {
    const { threads, runner, orchestrator, plans, threadId } = harness;

    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "plan something" }
    });
    await orchestrator.onThreadMessage(threadId);
    const handle = runner.handles[0]!;

    handle.emitChunk({
      type: "tool_use",
      toolUseId: "tu-1",
      name: "propose_plan",
      input: { drafts: [{ title: "A", description: "a" }] }
    });
    // Let the tool handler's microtasks settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(handle.toolResults).toHaveLength(1);
    const result = handle.toolResults[0]!.result as {
      plan: { id: string; status: string };
    };
    expect(result.plan.status).toBe("pending");
    expect(plans.listPlansByThread(threadId)).toHaveLength(1);

    const toolMessages = threads
      .listMessages(threadId)
      .filter((message) => message.kind === "tool_call" || message.kind === "tool_output");
    expect(toolMessages.map((message) => message.kind)).toEqual([
      "tool_call",
      "tool_output"
    ]);
    expect(toolMessages[0]?.payload).toMatchObject({
      toolUseId: "tu-1",
      name: "propose_plan",
      status: "started"
    });
    expect(toolMessages[1]?.payload).toMatchObject({
      toolUseId: "tu-1",
      name: "propose_plan",
      status: "completed"
    });
  });

  it("streams assistant text chunks into a single kind='chat' message", async () => {
    const { threads, runner, orchestrator, threadId } = harness;
    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "greet me" }
    });
    await orchestrator.onThreadMessage(threadId);
    const handle = runner.handles[0]!;

    handle.emitChunk({ type: "text", text: "hello ", outputId: "turn-1:item-1" });
    handle.emitChunk({ type: "text", text: "there", outputId: "turn-1:item-1" });

    const msgs = threads.listMessages(threadId);
    const chat = msgs.filter((m) => m.sender.type === "agent");
    expect(chat).toHaveLength(1);
    expect(chat[0]?.payload).toEqual({
      text: "hello there",
      outputId: "turn-1:item-1"
    });
  });

  it("preserves message boundaries for complete assistant updates", async () => {
    const { threads, runner, orchestrator, threadId } = harness;
    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "status?" }
    });
    await orchestrator.onThreadMessage(threadId);
    const handle = runner.handles[0]!;

    handle.emitChunk({
      type: "text",
      text: "checking the renderer",
      mode: "message",
      outputId: "turn-1:item-1"
    });
    handle.emitChunk({
      type: "text",
      text: "root cause confirmed",
      mode: "message",
      outputId: "turn-1:item-2"
    });

    const chats = threads
      .listMessages(threadId)
      .filter((m) => m.kind === "chat" && m.sender.type === "agent");
    expect(chats).toHaveLength(2);
    expect(chats.map((message) => message.payload)).toEqual([
      { text: "checking the renderer", outputId: "turn-1:item-1" },
      { text: "root cause confirmed", outputId: "turn-1:item-2" }
    ]);
  });

  it("surfaces runner activity chunks as thread messages", async () => {
    const { threads, runner, orchestrator, threadId } = harness;
    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "run a command" }
    });
    await orchestrator.onThreadMessage(threadId);
    const handle = runner.handles[0]!;

    handle.emitChunk({
      type: "activity",
      kind: "tool_call",
      text: "npm test",
      title: "Command Execution started",
      stream: "system",
      source: "item/started",
      metadata: {
        groupId: "item:turn-1:cmd-1",
        itemType: "commandExecution",
        phase: "started"
      }
    });

    const toolMessages = threads
      .listMessages(threadId)
      .filter((message) => message.kind === "tool_call");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.payload).toMatchObject({
      text: "npm test",
      title: "Command Execution started",
      status: "started",
      toolUseId: "item:turn-1:cmd-1"
    });
  });

  it("persists the runner session key on session_key chunks", async () => {
    const { threads, runner, orchestrator, threadId, store } = harness;
    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "kick off" }
    });
    await orchestrator.onThreadMessage(threadId);
    const handle = runner.handles[0]!;

    handle.emitChunk({ type: "session_key", key: "claude-resume-123" });
    await new Promise((resolve) => setImmediate(resolve));

    const session = store.getAgentSessionByThread(threadId);
    expect(session?.runnerSessionKey).toBe("claude-resume-123");
  });
});

describe("Orchestrator — system event injection", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  afterEach(() => {
    harness.orchestrator.stop();
  });

  it("injects a system_event when a plan is approved", async () => {
    const { threads, plans, runner, orchestrator, threadId } = harness;

    // Seed: propose a plan from a user message so the coordinator thread owns it.
    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "propose" }
    });
    await orchestrator.onThreadMessage(threadId);
    const handle = runner.handles[0]!;

    const plan = plans.propose({
      threadId,
      proposerAgentId: "wa-1",
      drafts: [{ title: "A", description: "a" }]
    });

    // Finish the first run so the orchestrator is idle when approval lands.
    await handle.finish();

    plans.approve(plan.id);
    // Let the event subscriber + serialize chain resolve.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const msgs = threads.listMessages(threadId);
    const systemEvents = msgs.filter((m) => m.kind === "system_event");
    expect(systemEvents.length).toBeGreaterThanOrEqual(1);
    expect(systemEvents[0]?.payload).toMatchObject({
      kind: "plan.updated",
      planId: plan.id
    });
  });
});

describe("Orchestrator — plan-approve-execute loop", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  afterEach(() => {
    harness.orchestrator.stop();
  });

  it("drives the full propose → approve → next-turn loop", async () => {
    const { threads, runner, orchestrator, plans, tasks, threadId, workspace } =
      harness;

    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "please plan the FAQ rewrite" }
    });
    await orchestrator.onThreadMessage(threadId);
    expect(runner.handles).toHaveLength(1);
    const firstHandle = runner.handles[0]!;

    firstHandle.emitChunk({
      type: "tool_use",
      toolUseId: "tu-1",
      name: "propose_plan",
      input: {
        drafts: [
          { title: "Draft outline", description: "sketch FAQ sections" },
          {
            title: "Write copy",
            description: "draft answers",
            dependsOn: ["Draft outline"]
          }
        ]
      }
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(firstHandle.toolResults).toHaveLength(1);
    const proposeResult = firstHandle.toolResults[0]!.result as {
      plan: { id: string; status: string };
    };
    expect(proposeResult.plan.status).toBe("pending");
    const planId = proposeResult.plan.id;

    // Run 1 finishes — thread goes idle.
    await firstHandle.finish();
    expect(threads.requireThread(threadId).coordinatorState).toBe("idle");
    expect(runner.handles).toHaveLength(1);

    // User approves the plan. Orchestrator reacts by injecting system_events
    // and auto-triggering a fresh coordinator turn.
    const approveResult = plans.approve(planId);
    expect(approveResult.tasks).toHaveLength(2);
    for (const task of approveResult.tasks) {
      expect(task.column).toBe("todo");
      expect(task.source).toBe("agent_plan");
      expect(task.planId).toBe(planId);
    }

    // Let plan.updated → onServerEvent → injectSystemEvent →
    // onThreadMessage (for the plan) and each task.updated → same chain
    // settle. Give the serialize queue a few flushes.
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // A second runner handle should exist, carrying system_events as its
    // append payload so the coordinator sees the approval + new tasks.
    expect(runner.handles.length).toBeGreaterThanOrEqual(2);
    const secondHandle = runner.handles[runner.handles.length - 1]!;
    const appendContents = secondHandle.input.appendMessages.map(
      (m) => m.content
    );
    const parsedEvents = appendContents
      .map((c) => {
        try {
          return JSON.parse(c) as {
            kind?: string;
            payload?: Record<string, unknown>;
          };
        } catch {
          return undefined;
        }
      })
      .filter(
        (e): e is { kind: string; payload: Record<string, unknown> } =>
          !!e && e.kind === "system_event"
      );

    const planEvents = parsedEvents.filter(
      (e) => e.payload.kind === "plan.updated"
    );
    const taskEvents = parsedEvents.filter(
      (e) => e.payload.kind === "task.updated"
    );
    expect(planEvents.length).toBeGreaterThanOrEqual(1);
    expect(planEvents[0]?.payload).toMatchObject({
      planId,
      status: "approved"
    });
    expect(taskEvents).toHaveLength(2);
    const eventTaskIds = taskEvents.map((e) => e.payload.taskId).sort();
    const actualTaskIds = approveResult.tasks.map((t) => t.id).sort();
    expect(eventTaskIds).toEqual(actualTaskIds);

    // Store invariants: plan is approved, both tasks in todo column.
    expect(plans.requirePlan(planId).status).toBe("approved");
    const todoTasks = tasks.listTasks(workspace.id, { column: "todo" });
    expect(todoTasks).toHaveLength(2);
  });
});

describe("Orchestrator — no-op surfaces", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  afterEach(() => {
    harness.orchestrator.stop();
  });

  it("text-only coordinator output creates a chat message but no tasks/plans", async () => {
    const { threads, runner, orchestrator, plans, tasks, threadId, workspace } =
      harness;
    threads.appendMessage({
      threadId,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "just say hi" }
    });
    await orchestrator.onThreadMessage(threadId);
    const handle = runner.handles[0]!;

    handle.emitChunk({ type: "text", text: "Hi, noted." });
    await handle.finish();

    expect(plans.listPlansByThread(threadId)).toHaveLength(0);
    expect(tasks.listTasks(workspace.id)).toHaveLength(0);
    const chats = threads
      .listMessages(threadId)
      .filter((m) => m.kind === "chat" && m.sender.type === "agent");
    expect(chats).toHaveLength(1);
  });
});
