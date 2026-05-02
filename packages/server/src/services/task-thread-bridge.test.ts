import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import type { Message, Run, ServerEvent, Task, Thread, WorkspaceAgent } from "@workhorse/contracts";

import { createRunLogEntry } from "../lib/run-log.js";
import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";
import { BoardService } from "./board-service.js";
import { TaskThreadBridge } from "./task-thread-bridge.js";
import { ThreadService } from "./thread-service.js";

interface TestRuntime {
  store: StateStore;
  events: EventBus;
  threads: ThreadService;
  bridge: TaskThreadBridge;
  task: Task;
  taskThread: Thread;
  coordinatorThread: Thread;
  worker: WorkspaceAgent;
  reviewer: WorkspaceAgent;
  published: ServerEvent[];
  sendTaskInput: ReturnType<typeof vi.fn>;
  triggerCoordinator: ReturnType<typeof vi.fn>;
}

async function createRuntime(): Promise<TestRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), "workhorse-task-thread-bridge-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "workhorse-task-thread-workspace-"));
  const store = new StateStore(dataDir);
  const events = new EventBus();
  const published: ServerEvent[] = [];
  events.subscribe((event) => {
    published.push(event);
  });

  const service = new BoardService(store, events, {
    runners: {} as never
  });
  await service.initialize();
  const threads = new ThreadService(store, events);
  const sendTaskInput = vi.fn(async () => undefined);
  const triggerCoordinator = vi.fn(async () => undefined);
  const bridge = new TaskThreadBridge({
    store,
    events,
    threads,
    sendTaskInput,
    triggerCoordinator
  });
  bridge.start();

  const workspace = await service.createWorkspace({
    name: "Bridge Test",
    rootPath: workspaceDir
  });
  const workerAccount = service.createAgent({
    name: "Builder",
    description: "Implements tasks.",
    runnerConfig: {
      type: "codex",
      prompt: "Build the task.",
      approvalMode: "default"
    }
  });
  const reviewerAccount = service.createAgent({
    name: "Business Reviewer",
    description: "Reviews user-facing behavior and business fit.",
    runnerConfig: {
      type: "codex",
      prompt: "Review the task.",
      approvalMode: "default"
    }
  });
  const coordinatorAccount = service.createAgent({
    name: "Coordinator",
    description: "Coordinates task work.",
    runnerConfig: {
      type: "claude",
      prompt: "Coordinate the task."
    }
  });
  const worker = service.mountAgent(workspace.id, {
    agentId: workerAccount.id,
    role: "worker"
  });
  const reviewer = service.mountAgent(workspace.id, {
    agentId: reviewerAccount.id,
    role: "worker"
  });
  const coordinator = service.mountAgent(workspace.id, {
    agentId: coordinatorAccount.id,
    role: "coordinator"
  });
  const task = await service.createTask({
    title: "Ship review routing",
    workspaceId: workspace.id,
    assigneeAgentId: worker.id
  });
  const taskThread = threads.createThread({
    workspaceId: workspace.id,
    kind: "task",
    taskId: task.id
  });
  const coordinatorThread = threads.createThread({
    workspaceId: workspace.id,
    kind: "coordinator",
    coordinatorAgentId: coordinator.id
  });

  return {
    store,
    events,
    threads,
    bridge,
    task,
    taskThread,
    coordinatorThread,
    worker,
    reviewer,
    published,
    sendTaskInput,
    triggerCoordinator
  };
}

function createRun(task: Task, metadata: Record<string, string> = {}): Run {
  const startedAt = new Date().toISOString();
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    taskId: task.id,
    status: "running",
    runnerType: "codex",
    command: "codex test runner",
    startedAt,
    logFile: `/tmp/${task.id}.jsonl`,
    metadata
  };
}

describe("TaskThreadBridge", () => {
  it("mirrors run start and structured output into the task thread", async () => {
    const runtime = await createRuntime();
    const run = createRun(runtime.task);
    runtime.store.setRuns([run]);
    await runtime.store.save();

    runtime.events.publish({
      type: "run.started",
      taskId: runtime.task.id,
      run
    });
    const entry = createRunLogEntry(run.id, {
      kind: "agent",
      text: "Implemented the task.\n",
      stream: "stdout",
      title: "Agent response",
      source: "Codex"
    });
    runtime.events.publish({
      type: "run.output",
      taskId: runtime.task.id,
      runId: run.id,
      entry
    });

    const messages = runtime.threads.listMessages(runtime.taskThread.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.kind).toBe("status");
    expect(messages[1]).toMatchObject({
      sender: { type: "agent", agentId: runtime.worker.id },
      kind: "chat"
    });
    expect((messages[1]?.payload as { metadata?: Record<string, string> }).metadata).toMatchObject({
      mirroredFromRunLog: "true",
      runId: run.id,
      runEntryId: entry.id,
      entryKind: "agent"
    });
    expect(
      runtime.published.some(
        (event) =>
          event.type === "thread.message" &&
          event.threadId === runtime.taskThread.id &&
          event.message.id === messages[1]?.id
      )
    ).toBe(true);
  });

  it("keeps unmentioned task-thread chat local and routes @coordinator", async () => {
    const runtime = await createRuntime();

    const localMessage = runtime.threads.appendMessage({
      threadId: runtime.taskThread.id,
      sender: { type: "user" },
      kind: "chat",
      payload: runtime.bridge.buildUserPayload(runtime.taskThread, "FYI only")
    });
    await runtime.bridge.routeUserMessage(runtime.taskThread, localMessage);
    expect(runtime.triggerCoordinator).not.toHaveBeenCalled();

    const mentionMessage = runtime.threads.appendMessage({
      threadId: runtime.taskThread.id,
      sender: { type: "user" },
      kind: "chat",
      payload: runtime.bridge.buildUserPayload(
        runtime.taskThread,
        "@coordinator please decide the next review step"
      )
    });
    await runtime.bridge.routeUserMessage(runtime.taskThread, mentionMessage);

    expect(runtime.triggerCoordinator).toHaveBeenCalledWith(runtime.coordinatorThread.id);
    const coordinatorMessages = runtime.threads.listMessages(runtime.coordinatorThread.id);
    expect(coordinatorMessages.at(-1)).toMatchObject({
      sender: { type: "system" },
      kind: "system_event"
    });
    expect((coordinatorMessages.at(-1)?.payload as { kind?: string }).kind).toBe(
      "task_thread.mention"
    );
  });

  it("delivers @agentName to an active codex review run selected by metadata", async () => {
    const runtime = await createRuntime();
    const run = createRun(runtime.task, {
      reviewAgentId: runtime.reviewer.id
    });
    runtime.store.setRuns([run]);
    await runtime.store.save();

    const message = runtime.threads.appendMessage({
      threadId: runtime.taskThread.id,
      sender: { type: "user" },
      kind: "chat",
      payload: runtime.bridge.buildUserPayload(
        runtime.taskThread,
        "@Business Reviewer can you check the launch wording?"
      )
    });
    await runtime.bridge.routeUserMessage(runtime.taskThread, message);

    expect(runtime.sendTaskInput).toHaveBeenCalledWith(runtime.task.id, {
      text: "@Business Reviewer can you check the launch wording?"
    });
    const updated = runtime.threads.listMessages(runtime.taskThread.id).find(
      (entry) => entry.id === message.id
    ) as Message;
    expect((updated.payload as { deliveredAgentIds?: string[] }).deliveredAgentIds).toContain(
      runtime.reviewer.id
    );
  });

  it("adds a completion fallback and notifies coordinator when final output lacks @coordinator", async () => {
    const runtime = await createRuntime();
    const run = {
      ...createRun(runtime.task),
      status: "succeeded" as const,
      endedAt: new Date().toISOString()
    };
    runtime.store.setRuns([run]);
    await runtime.store.appendLogEntry(
      run.id,
      createRunLogEntry(run.id, {
        kind: "agent",
        text: "Done without an explicit mention.",
        stream: "stdout"
      })
    );

    runtime.events.publish({
      type: "run.finished",
      taskId: runtime.task.id,
      run,
      task: runtime.task
    });
    await sleep(10);

    const taskMessages = runtime.threads.listMessages(runtime.taskThread.id);
    expect(taskMessages.some((message) => {
      const payload = message.payload as { kind?: string };
      return payload.kind === "coordinator_completion_fallback";
    })).toBe(true);
    expect(runtime.triggerCoordinator).toHaveBeenCalledWith(runtime.coordinatorThread.id);
    const coordinatorMessages = runtime.threads.listMessages(runtime.coordinatorThread.id);
    expect((coordinatorMessages.at(-1)?.payload as { kind?: string }).kind).toBe(
      "task_thread.run_finished"
    );
  });
});
