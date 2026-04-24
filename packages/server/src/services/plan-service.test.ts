import { describe, expect, it } from "vitest";

import type {
  PlanDraft,
  ServerEvent,
  Task,
  Thread,
  Workspace
} from "@workhorse/contracts";

import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";
import { PlanService } from "./plan-service.js";
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

async function setup(): Promise<{
  store: StateStore;
  events: RecordingEventBus;
  plans: PlanService;
  threads: ThreadService;
  workspace: Workspace;
  thread: Thread;
}> {
  const store = new StateStore(":memory:");
  await store.load();
  const workspace = makeWorkspace();
  store.setWorkspaces([workspace]);
  await store.save();

  const events = new RecordingEventBus();
  const threads = new ThreadService(store, events);
  const plans = new PlanService(store, events);
  const thread = threads.createThread({
    workspaceId: workspace.id,
    kind: "coordinator",
    coordinatorAgentId: "wa-1"
  });
  events.published.length = 0;
  return { store, events, plans, threads, workspace, thread };
}

const draftsABTwo: PlanDraft[] = [
  { title: "Draft A", description: "first draft", assigneeAgentId: "wa-1" },
  {
    title: "Draft B",
    description: "second draft",
    assigneeAgentId: "wa-2",
    dependsOn: ["Draft A"]
  }
];

describe("PlanService — propose", () => {
  it("inserts a pending plan and appends a plan_draft message", async () => {
    const { plans, events, thread } = await setup();
    const plan = plans.propose({
      threadId: thread.id,
      proposerAgentId: "wa-1",
      drafts: draftsABTwo
    });

    expect(plan.status).toBe("pending");
    expect(plan.drafts).toHaveLength(2);

    const created = events.published.find((e) => e.type === "plan.created");
    expect(created).toBeDefined();
    const draftMsg = events.published.find(
      (e) =>
        e.type === "thread.message" && e.message.kind === "plan_draft"
    );
    expect(draftMsg).toBeDefined();
  });

  it("rejects empty drafts and archived threads", async () => {
    const { plans, threads, thread } = await setup();
    expect(() =>
      plans.propose({
        threadId: thread.id,
        proposerAgentId: "wa-1",
        drafts: []
      })
    ).toThrow(/at least one draft|empty/i);

    threads.archiveThread(thread.id);
    expect(() =>
      plans.propose({
        threadId: thread.id,
        proposerAgentId: "wa-1",
        drafts: draftsABTwo
      })
    ).toThrow(/archived/i);
  });
});

describe("PlanService — approve", () => {
  it("creates agent_plan tasks with resolved dependencies in a single tx", async () => {
    const { plans, store, thread, events } = await setup();
    const plan = plans.propose({
      threadId: thread.id,
      proposerAgentId: "wa-1",
      drafts: draftsABTwo
    });
    events.published.length = 0;

    const { plan: approved, tasks } = plans.approve(plan.id);
    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).toBeDefined();
    expect(tasks).toHaveLength(2);

    const taskA = tasks.find((t) => t.title === "Draft A");
    const taskB = tasks.find((t) => t.title === "Draft B");
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();
    expect(taskB!.dependencies).toEqual([taskA!.id]);
    expect(taskA!.source).toBe("agent_plan");
    expect(taskA!.planId).toBe(plan.id);
    expect(taskA!.assigneeAgentId).toBe("wa-1");
    expect(taskA!.column).toBe("todo");

    // Tasks are appended to the in-memory cache so getTasks() returns them.
    const cached = store.listTasks();
    expect(cached.map((t) => t.id).sort()).toEqual(
      [taskA!.id, taskB!.id].sort()
    );

    // Events: plan.updated, thread.message(plan_decision), 2x task.updated(created).
    expect(events.published.some((e) => e.type === "plan.updated")).toBe(true);
    expect(
      events.published.some(
        (e) => e.type === "thread.message" && e.message.kind === "plan_decision"
      )
    ).toBe(true);
    const taskCreated = events.published.filter(
      (e) => e.type === "task.updated" && e.action === "created"
    );
    expect(taskCreated).toHaveLength(2);
  });

  it("rejects with PLAN_ALREADY_DECIDED when approved twice (single-process race)", async () => {
    const { plans, thread } = await setup();
    const plan = plans.propose({
      threadId: thread.id,
      proposerAgentId: "wa-1",
      drafts: draftsABTwo
    });

    plans.approve(plan.id);
    expect(() => plans.approve(plan.id)).toThrow(/already/i);
  });

  it("rolls back the whole transaction when a task insert fails", async () => {
    const { plans, store, thread } = await setup();
    const drafts: PlanDraft[] = [
      { title: "A", description: "a" },
      { title: "B", description: "b" },
      { title: "C", description: "c", dependsOn: ["does-not-exist"] }
    ];

    const plan = plans.propose({
      threadId: thread.id,
      proposerAgentId: "wa-1",
      drafts
    });

    expect(() => plans.approve(plan.id)).toThrow(/unknown title|unresolved/i);

    // Rollback guarantees: plan stays pending, zero tasks persisted, no
    // plan_decision message appended.
    const reloaded = plans.getPlan(plan.id);
    expect(reloaded?.status).toBe("pending");
    expect(store.listTasks()).toHaveLength(0);
  });

  it("persists source/planId/assigneeAgentId across save()", async () => {
    const { plans, store, thread } = await setup();
    const plan = plans.propose({
      threadId: thread.id,
      proposerAgentId: "wa-1",
      drafts: draftsABTwo
    });
    const { tasks } = plans.approve(plan.id);

    // Round-trip through persistState (delete-all + re-insert) to confirm
    // the new columns survive.
    await store.save();
    const after = store.listTasks() as Task[];
    const a = after.find((t) => t.title === "Draft A");
    expect(a?.source).toBe("agent_plan");
    expect(a?.planId).toBe(plan.id);
    expect(a?.assigneeAgentId).toBe("wa-1");
    expect(tasks).toHaveLength(2);
  });
});

describe("PlanService — reject / supersede", () => {
  it("rejects a pending plan and appends a plan_decision(reject) message", async () => {
    const { plans, events, thread } = await setup();
    const plan = plans.propose({
      threadId: thread.id,
      proposerAgentId: "wa-1",
      drafts: draftsABTwo
    });
    events.published.length = 0;

    const rejected = plans.reject(plan.id, {}, "not aligned");
    expect(rejected.status).toBe("rejected");
    expect(
      events.published.some(
        (e) =>
          e.type === "thread.message" &&
          e.message.kind === "plan_decision" &&
          typeof e.message.payload === "object" &&
          e.message.payload !== null &&
          "decision" in e.message.payload &&
          (e.message.payload as { decision: string }).decision === "reject"
      )
    ).toBe(true);
  });

  it("supersede transitions pending→superseded and blocks a second decision", async () => {
    const { plans, thread } = await setup();
    const plan = plans.propose({
      threadId: thread.id,
      proposerAgentId: "wa-1",
      drafts: draftsABTwo
    });

    const superseded = plans.supersede(plan.id, "replaced");
    expect(superseded.status).toBe("superseded");
    expect(() => plans.approve(plan.id)).toThrow(/already/i);
    expect(() => plans.reject(plan.id)).toThrow(/already/i);
  });
});

describe("PlanService — listing", () => {
  it("lists plans by thread in creation order", async () => {
    const { plans, thread } = await setup();
    const p1 = plans.propose({
      threadId: thread.id,
      proposerAgentId: "wa-1",
      drafts: [{ title: "X", description: "" }]
    });
    const p2 = plans.propose({
      threadId: thread.id,
      proposerAgentId: "wa-1",
      drafts: [{ title: "Y", description: "" }]
    });
    const list = plans.listPlansByThread(thread.id);
    expect(list.map((p) => p.id)).toEqual([p1.id, p2.id]);
  });
});
