import { beforeEach, describe, expect, it } from "vitest";

import type { ServerEvent, Workspace } from "@workhorse/contracts";

import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";
import { ThreadService } from "./thread-service.js";

class RecordingEventBus extends EventBus {
  public readonly published: ServerEvent[] = [];

  public override publish(event: ServerEvent): void {
    this.published.push(event);
    super.publish(event);
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

async function setup() {
  const store = new StateStore(":memory:");
  await store.load();
  const workspace = makeWorkspace();
  store.setWorkspaces([workspace]);
  await store.save();
  const events = new RecordingEventBus();
  const service = new ThreadService(store, events);
  return { store, events, service, workspace };
}

describe("ThreadService — thread lifecycle", () => {
  it("creates a thread with idle state and publishes thread.updated created", async () => {
    const { service, events, workspace } = await setup();
    const thread = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator",
      coordinatorAgentId: "wa-1"
    });
    expect(thread.kind).toBe("coordinator");
    expect(thread.coordinatorState).toBe("idle");
    expect(thread.coordinatorAgentId).toBe("wa-1");

    const created = events.published.find(
      (e) => e.type === "thread.updated" && e.action === "created"
    );
    expect(created).toBeDefined();
  });

  it("lists and fetches threads by workspace", async () => {
    const { service, workspace } = await setup();
    const t1 = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator"
    });
    const t2 = service.createThread({
      workspaceId: workspace.id,
      kind: "direct"
    });

    const list = service.listThreads(workspace.id);
    expect(list.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    expect(service.getThread(t1.id)?.kind).toBe("coordinator");
  });

  it("archives a thread and blocks further message appends", async () => {
    const { service, workspace } = await setup();
    const thread = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator"
    });
    const archived = service.archiveThread(thread.id);
    expect(archived.archivedAt).toBeDefined();

    expect(() =>
      service.appendMessage({
        threadId: thread.id,
        sender: { type: "user" },
        kind: "chat",
        payload: { text: "hi" }
      })
    ).toThrow(/archived/i);
  });
});

describe("ThreadService — messages", () => {
  it("appends messages in order and publishes thread.message for each", async () => {
    const { service, events, workspace } = await setup();
    const thread = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator"
    });
    events.published.length = 0;

    const m1 = service.appendMessage({
      threadId: thread.id,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "one" }
    });
    const m2 = service.appendMessage({
      threadId: thread.id,
      sender: { type: "agent", agentId: "wa-1" },
      kind: "chat",
      payload: { text: "two" }
    });
    const m3 = service.appendMessage({
      threadId: thread.id,
      sender: { type: "system" },
      kind: "system_event",
      payload: { action: "run_started" }
    });

    const messageEvents = events.published.filter(
      (e) => e.type === "thread.message"
    );
    expect(messageEvents).toHaveLength(3);

    const listed = service.listMessages(thread.id);
    expect(listed.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
    expect(listed[0]?.sender).toEqual({ type: "user" });
    expect(listed[1]?.sender).toEqual({ type: "agent", agentId: "wa-1" });
    expect(listed[2]?.sender).toEqual({ type: "system" });
    expect(listed[0]?.payload).toEqual({ text: "one" });
  });

  it("listPendingMessages returns user messages with consumed_by_run_id IS NULL", async () => {
    const { service, workspace } = await setup();
    const thread = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator"
    });
    const u1 = service.appendMessage({
      threadId: thread.id,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "u1" }
    });
    service.appendMessage({
      threadId: thread.id,
      sender: { type: "agent", agentId: "wa-1" },
      kind: "chat",
      payload: { text: "a1" }
    });
    const u2 = service.appendMessage({
      threadId: thread.id,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "u2" }
    });

    const pendingAll = service.listPendingMessages(thread.id);
    expect(pendingAll.map((m) => m.id)).toEqual([u1.id, u2.id]);

    service.markMessagesConsumed(thread.id, [u1.id], "run-1");
    const pendingAfter = service.listPendingMessages(thread.id);
    expect(pendingAfter.map((m) => m.id)).toEqual([u2.id]);

    const all = service.listMessages(thread.id);
    const u1Row = all.find((m) => m.id === u1.id);
    expect(u1Row?.consumedByRunId).toBe("run-1");
  });
});

describe("ThreadService — coordinator state machine", () => {
  it("allows idle → queued → running → idle transitions", async () => {
    const { service, workspace } = await setup();
    const thread = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator"
    });

    const queued = service.setCoordinatorState(thread.id, "queued");
    expect(queued.coordinatorState).toBe("queued");

    const running = service.setCoordinatorState(thread.id, "running");
    expect(running.coordinatorState).toBe("running");

    const idle = service.setCoordinatorState(thread.id, "idle");
    expect(idle.coordinatorState).toBe("idle");
  });

  it("rejects invalid transitions (running → queued)", async () => {
    const { service, workspace } = await setup();
    const thread = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator"
    });
    service.setCoordinatorState(thread.id, "running");

    expect(() => service.setCoordinatorState(thread.id, "queued")).toThrow(
      /invalid.*transition/i
    );
  });

  it("enqueueCoordinatorTrigger returns state + pending user messages", async () => {
    const { service, workspace } = await setup();
    const thread = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator"
    });

    // idle + no pending
    const empty = service.enqueueCoordinatorTrigger(thread.id);
    expect(empty.state).toBe("idle");
    expect(empty.pending).toHaveLength(0);

    // idle + one user message
    service.appendMessage({
      threadId: thread.id,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "hi" }
    });
    const one = service.enqueueCoordinatorTrigger(thread.id);
    expect(one.state).toBe("idle");
    expect(one.pending).toHaveLength(1);

    // running + new user message: state stays running, pending contains msg
    service.setCoordinatorState(thread.id, "running");
    service.appendMessage({
      threadId: thread.id,
      sender: { type: "user" },
      kind: "chat",
      payload: { text: "second" }
    });
    const running = service.enqueueCoordinatorTrigger(thread.id);
    expect(running.state).toBe("running");
    expect(running.pending).toHaveLength(2);
  });
});

describe("ThreadService — agent sessions", () => {
  it("getOrCreateSession is idempotent per (threadId, agentId)", async () => {
    const { service, workspace } = await setup();
    const thread = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator"
    });
    const s1 = service.getOrCreateSession(thread.id, "agent-1");
    const s2 = service.getOrCreateSession(thread.id, "agent-1");
    expect(s2.id).toBe(s1.id);
  });

  it("rejects binding a second agent to the same thread", async () => {
    const { service, workspace } = await setup();
    const thread = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator"
    });
    service.getOrCreateSession(thread.id, "agent-1");
    expect(() => service.getOrCreateSession(thread.id, "agent-2")).toThrow(
      /session_mismatch|not/i
    );
  });

  it("persists runnerSessionKey via updateSessionRunnerKey", async () => {
    const { service, workspace } = await setup();
    const thread = service.createThread({
      workspaceId: workspace.id,
      kind: "coordinator"
    });
    const session = service.getOrCreateSession(thread.id, "agent-1");
    const updated = service.updateSessionRunnerKey(session.id, "claude:abc123");
    expect(updated.runnerSessionKey).toBe("claude:abc123");

    // Second call returns the cached row (same session key shown).
    const again = service.getOrCreateSession(thread.id, "agent-1");
    expect(again.runnerSessionKey).toBe("claude:abc123");
  });
});
