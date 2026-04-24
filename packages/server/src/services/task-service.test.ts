import { describe, expect, it } from "vitest";

import type {
  PlanDraft,
  ServerEvent,
  Workspace
} from "@workhorse/contracts";

import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";
import { PlanService } from "./plan-service.js";
import { TaskService } from "./task-service.js";
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
  tasks: TaskService;
  plans: PlanService;
  threads: ThreadService;
  workspace: Workspace;
}> {
  const store = new StateStore(":memory:");
  await store.load();
  const workspace = makeWorkspace();
  store.setWorkspaces([workspace]);
  await store.save();

  const events = new RecordingEventBus();
  const threads = new ThreadService(store, events);
  const plans = new PlanService(store, events);
  const tasks = new TaskService(store, threads, events);
  return { store, events, tasks, plans, threads, workspace };
}

describe("TaskService — create + thread pairing", () => {
  it("creates a task with default column=todo and a paired kind='task' thread", async () => {
    const { tasks, threads, workspace, events } = await setup();
    const { task, thread } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "First task",
      description: "hello"
    });
    expect(task.column).toBe("todo");
    expect(task.source).toBe("user");
    expect(thread.kind).toBe("task");
    expect(thread.taskId).toBe(task.id);

    const list = threads.listThreads(workspace.id);
    const pair = list.find((t) => t.taskId === task.id);
    expect(pair?.id).toBe(thread.id);
    expect(
      events.published.some((e) => e.type === "task.updated" && e.action === "created")
    ).toBe(true);
  });

  it("pairs each of N tasks with exactly one task thread", async () => {
    const { tasks, threads, workspace } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { task } = await tasks.createTask({
        workspaceId: workspace.id,
        title: `t${i}`
      });
      ids.push(task.id);
    }
    const threadTaskIds = threads
      .listThreads(workspace.id)
      .filter((t) => t.kind === "task")
      .map((t) => t.taskId)
      .sort();
    expect(threadTaskIds).toEqual([...ids].sort());
  });
});

describe("TaskService — column invariants", () => {
  it("rejects user drag into running", async () => {
    const { tasks, workspace } = await setup();
    const { task } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "t"
    });
    await expect(tasks.updateColumn(task.id, "running", "user")).rejects.toThrow(
      /invalid_transition|cannot move/i
    );
  });

  it("rejects user drag away from running (must cancel run first)", async () => {
    const { tasks, workspace } = await setup();
    const { task } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "t"
    });
    // System can move it into running.
    await tasks.updateColumn(task.id, "running", "system");
    await expect(tasks.updateColumn(task.id, "todo", "user")).rejects.toThrow(
      /invalid_transition|cannot move/i
    );
  });

  it("allows user backlog↔todo and todo→archived", async () => {
    const { tasks, workspace } = await setup();
    const { task } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "t",
      column: "backlog"
    });
    const a = await tasks.updateColumn(task.id, "todo", "user");
    expect(a.column).toBe("todo");
    const b = await tasks.updateColumn(task.id, "backlog", "user");
    expect(b.column).toBe("backlog");
    const c = await tasks.updateColumn(task.id, "archived", "user");
    expect(c.column).toBe("archived");
  });

  it("same-column update is a no-op", async () => {
    const { tasks, workspace } = await setup();
    const { task } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "t"
    });
    const result = await tasks.updateColumn(task.id, "todo", "user");
    expect(result.id).toBe(task.id);
    expect(result.column).toBe("todo");
  });
});

describe("TaskService — run-finished transitions", () => {
  it("running → review on succeeded/failed, running → todo on interrupted", async () => {
    const { tasks, workspace } = await setup();
    const { task: t1 } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "t1"
    });
    await tasks.updateColumn(t1.id, "running", "system");
    const r1 = await tasks.onRunFinished(t1.id, "succeeded");
    expect(r1.column).toBe("review");

    const { task: t2 } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "t2"
    });
    await tasks.updateColumn(t2.id, "running", "system");
    const r2 = await tasks.onRunFinished(t2.id, "interrupted");
    expect(r2.column).toBe("todo");
  });

  it("is a no-op when task is not in running", async () => {
    const { tasks, workspace } = await setup();
    const { task } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "t"
    });
    const unchanged = await tasks.onRunFinished(task.id, "succeeded");
    expect(unchanged.column).toBe("todo");
  });
});

describe("TaskService — review approve/reject", () => {
  it("approveReview transitions review → done", async () => {
    const { tasks, workspace } = await setup();
    const { task } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "t"
    });
    await tasks.updateColumn(task.id, "running", "system");
    await tasks.onRunFinished(task.id, "succeeded");
    const done = await tasks.approveReview(task.id);
    expect(done.column).toBe("done");
  });

  it("rejectReview marks rejected and appends plan_decision message", async () => {
    const { tasks, threads, workspace, events } = await setup();
    const { task, thread } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "t"
    });
    await tasks.updateColumn(task.id, "running", "system");
    await tasks.onRunFinished(task.id, "succeeded");
    events.published.length = 0;

    const rejected = await tasks.rejectReview(task.id, {}, "not good");
    expect(rejected.column).toBe("done");
    expect(rejected.rejected).toBe(true);

    const msgs = threads.listMessages(thread.id);
    const decision = msgs.find((m) => m.kind === "plan_decision");
    expect(decision).toBeDefined();
  });

  it("refuses to approve/reject tasks that are not in review", async () => {
    const { tasks, workspace } = await setup();
    const { task } = await tasks.createTask({
      workspaceId: workspace.id,
      title: "t"
    });
    await expect(tasks.approveReview(task.id)).rejects.toThrow(/not review/i);
    await expect(tasks.rejectReview(task.id, {}, "x")).rejects.toThrow(
      /not review/i
    );
  });
});

describe("TaskService — plan cancellation", () => {
  it("cancelPendingTasksForPlan archives backlog/todo/blocked/running/review tasks", async () => {
    const { plans, tasks, store, threads, workspace } = await setup();
    const drafts: PlanDraft[] = [
      { title: "A", description: "a" },
      { title: "B", description: "b" },
      { title: "C", description: "c" }
    ];
    const plan = plans.propose({
      threadId: threads.createThread({
        workspaceId: workspace.id,
        kind: "coordinator"
      }).id,
      proposerAgentId: "wa-1",
      drafts
    });
    plans.approve(plan.id);

    const planTasks = store
      .listTasks()
      .filter((t) => t.planId === plan.id);
    expect(planTasks).toHaveLength(3);

    // Advance one task to 'done' manually — it should NOT be cancelled.
    const doneTarget = planTasks[0]!;
    await tasks.updateColumn(doneTarget.id, "running", "system");
    await tasks.onRunFinished(doneTarget.id, "succeeded");
    await tasks.approveReview(doneTarget.id);

    const count = await tasks.cancelPendingTasksForPlan(plan.id);
    expect(count).toBe(2);

    const afterAll = store.listTasks().filter((t) => t.planId === plan.id);
    const doneTask = afterAll.find((t) => t.id === doneTarget.id);
    expect(doneTask?.column).toBe("done");
    const archived = afterAll.filter((t) => t.column === "archived");
    expect(archived).toHaveLength(2);
    for (const t of archived) {
      expect(t.cancelledAt).toBeDefined();
    }
  });
});

describe("TaskService — listing", () => {
  it("filters by column / source / planId", async () => {
    const { tasks, workspace } = await setup();
    await tasks.createTask({
      workspaceId: workspace.id,
      title: "user-1",
      source: "user"
    });
    await tasks.createTask({
      workspaceId: workspace.id,
      title: "agent-1",
      source: "agent_plan",
      planId: "plan-x"
    });
    expect(
      tasks.listTasks(workspace.id, { source: "user" }).map((t) => t.title)
    ).toEqual(["user-1"]);
    expect(
      tasks.listTasks(workspace.id, { planId: "plan-x" }).map((t) => t.title)
    ).toEqual(["agent-1"]);
    expect(tasks.listTasks(workspace.id, { column: "todo" })).toHaveLength(2);
  });
});
