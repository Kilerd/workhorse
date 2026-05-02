import { describe, expect, it, vi } from "vitest";

import type { AccountAgent, Run, Task, Workspace } from "@workhorse/contracts";

import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";
import { PlanService } from "./plan-service.js";
import { TaskService } from "./task-service.js";
import { ThreadService } from "./thread-service.js";
import {
  ToolRegistry,
  buildDefaultToolRegistry,
  type ToolHandlerCtx
} from "./tool-registry.js";

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

function makeAgent(overrides: Partial<AccountAgent> = {}): AccountAgent {
  const now = new Date().toISOString();
  return {
    id: "agent-a",
    name: "Frontend worker",
    description: "Builds user-facing UI",
    runnerConfig: { type: "codex", prompt: "Do the assigned work." },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

async function setup(): Promise<{
  store: StateStore;
  tools: ToolRegistry;
  ctx: ToolHandlerCtx;
  threads: ThreadService;
  plans: PlanService;
  tasks: TaskService;
  workspaceId: string;
  threadId: string;
}> {
  const store = new StateStore(":memory:");
  await store.load();
  const workspace = makeWorkspace();
  store.setWorkspaces([workspace]);
  await store.save();
  const events = new EventBus();
  const threads = new ThreadService(store, events);
  const plans = new PlanService(store, events);
  const tasks = new TaskService(store, threads, events);
  const thread = threads.createThread({
    workspaceId: workspace.id,
    kind: "coordinator",
    coordinatorAgentId: "wa-1"
  });
  const tools = buildDefaultToolRegistry({ store, tasks, plans, threads });
  const ctx: ToolHandlerCtx = {
    workspaceId: workspace.id,
    threadId: thread.id,
    agentId: "wa-1"
  };
  return {
    store,
    tools,
    ctx,
    threads,
    plans,
    tasks,
    workspaceId: workspace.id,
    threadId: thread.id
  };
}

describe("ToolRegistry — basics", () => {
  it("rejects duplicate registration and unknown lookups", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "noop",
      description: "",
      inputSchema: {},
      handler: async () => ({ ok: true })
    });
    expect(() =>
      registry.register({
        name: "noop",
        description: "",
        inputSchema: {},
        handler: async () => ({ ok: true })
      })
    ).toThrow(/already/i);
    await expect(
      registry.invoke("missing", {}, {
        workspaceId: "w",
        threadId: "t",
        agentId: "a"
      })
    ).rejects.toThrow(/not registered/i);
  });

  it("lists the expected default tools", async () => {
    const { tools } = await setup();
    const names = tools.list().map((t) => t.name).sort();
    expect(names).toContain("create_task");
    expect(names).toContain("propose_plan");
    expect(names).toContain("post_message");
    expect(names).toContain("list_agents");
    expect(names).toContain("get_workspace_state");
    expect(names).toContain("decide_task");
  });

  it("returns account and workspace descriptions from list_agents", async () => {
    const { store, tools, ctx, workspaceId } = await setup();
    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(
      workspaceId,
      "agent-a",
      "worker",
      "Only handle React settings screens in this workspace."
    );

    const out = (await tools.invoke("list_agents", {}, ctx)) as {
      agents: Array<{
        workspaceAgentId: string;
        accountDescription: string;
        workspaceDescription?: string;
      }>;
    };

    expect(out.agents).toEqual([
      expect.objectContaining({
        workspaceAgentId: "agent-a",
        accountDescription: "Builds user-facing UI",
        workspaceDescription: "Only handle React settings screens in this workspace."
      })
    ]);
  });
});

describe("ToolRegistry — create_task", () => {
  it("creates an agent_plan task with the agent as assignee", async () => {
    const { tools, ctx } = await setup();
    const out = (await tools.invoke(
      "create_task",
      {
        title: "Scaffold FAQ",
        description: "section on auth questions",
        assigneeAgentId: "wa-1"
      },
      ctx
    )) as { task: { id: string; source: string; assigneeAgentId?: string } };
    expect(out.task.source).toBe("agent_plan");
    expect(out.task.assigneeAgentId).toBe("wa-1");
  });

  it("rejects invalid input shape", async () => {
    const { tools, ctx } = await setup();
    await expect(tools.invoke("create_task", null, ctx)).rejects.toThrow(
      /must be an object/i
    );
    await expect(tools.invoke("create_task", {}, ctx)).rejects.toThrow(
      /title/i
    );
  });
});

describe("ToolRegistry — start_task", () => {
  it("delegates execution starts to the run lifecycle", async () => {
    const base = await setup();
    let startedTaskId: string | undefined;
    const tools = buildDefaultToolRegistry({
      store: base.store,
      tasks: base.tasks,
      plans: base.plans,
      threads: base.threads,
      startTask: async (taskId) => {
        startedTaskId = taskId;
        const task = base.tasks.requireTask(taskId);
        const now = new Date().toISOString();
        return {
          task: { ...task, column: "running" },
          run: {
            id: "run-1",
            taskId,
            status: "running",
            runnerType: "codex",
            command: "codex",
            startedAt: now
          }
        };
      }
    });
    const { task } = await base.tasks.createTask({
      workspaceId: base.workspaceId,
      title: "run me"
    });

    const out = (await tools.invoke(
      "start_task",
      { taskId: task.id },
      base.ctx
    )) as { task: Task; run: Run };

    expect(startedTaskId).toBe(task.id);
    expect(out.task.column).toBe("running");
    expect(out.run).toMatchObject({
      taskId: task.id,
      status: "running",
      runnerType: "codex"
    });
  });
});

describe("ToolRegistry — request_task_review", () => {
  it("delegates one explicit selected agent review with requester and focus", async () => {
    const { store, tasks, plans, threads, ctx } = await setup();
    const requestTaskReview = vi.fn(async () => ({
      task: { id: "task-1" } as Task,
      run: { id: "run-1" } as Run
    }));
    const tools = buildDefaultToolRegistry({
      store,
      tasks,
      plans,
      threads,
      requestTaskReview
    });

    await tools.invoke(
      "request_task_review",
      {
        taskId: "task-1",
        reviewerAgentId: "agent-business",
        focus: "business review"
      },
      ctx
    );

    expect(requestTaskReview).toHaveBeenCalledWith("task-1", {
      reviewerAgentId: "agent-business",
      requesterAgentId: ctx.agentId,
      focus: "business review"
    });
  });
});

describe("ToolRegistry — propose_plan", () => {
  it("creates a pending plan on the caller's thread", async () => {
    const { tools, ctx, plans, threadId } = await setup();
    const out = (await tools.invoke(
      "propose_plan",
      {
        drafts: [
          { title: "A", description: "first" },
          { title: "B", description: "second", dependsOn: ["A"] }
        ]
      },
      ctx
    )) as { plan: { id: string; status: string; threadId: string } };
    expect(out.plan.status).toBe("pending");
    expect(out.plan.threadId).toBe(threadId);
    const listed = plans.listPlansByThread(threadId);
    expect(listed.map((p) => p.id)).toEqual([out.plan.id]);
  });

  it("rejects empty drafts array", async () => {
    const { tools, ctx } = await setup();
    await expect(
      tools.invoke("propose_plan", { drafts: [] }, ctx)
    ).rejects.toThrow(/non-empty/i);
  });
});

describe("ToolRegistry — post_message / annotate_task", () => {
  it("post_message defaults to the caller's thread", async () => {
    const { tools, ctx, threads, threadId } = await setup();
    await tools.invoke("post_message", { text: "hello" }, ctx);
    const msgs = threads.listMessages(threadId);
    expect(msgs.map((message) => message.kind)).toEqual([
      "tool_call",
      "chat",
      "tool_output"
    ]);
    expect(msgs.find((message) => message.kind === "chat")?.payload).toEqual({
      text: "hello"
    });
    expect(msgs.find((message) => message.kind === "tool_call")?.payload).toMatchObject({
      name: "post_message",
      status: "started"
    });
    expect(msgs.find((message) => message.kind === "tool_output")?.payload).toMatchObject({
      name: "post_message",
      status: "completed"
    });
  });

  it("annotate_task writes to the paired task thread", async () => {
    const { tools, ctx, tasks, threads, workspaceId } = await setup();
    const { task } = await tasks.createTask({
      workspaceId,
      title: "chore"
    });
    await tools.invoke("annotate_task", { taskId: task.id, text: "fyi" }, ctx);
    const taskThread = threads
      .listThreads(workspaceId)
      .find((t) => t.taskId === task.id && t.kind === "task");
    const msgs = threads.listMessages(taskThread!.id);
    expect(msgs.at(-1)?.payload).toEqual({ text: "fyi" });
  });
});

describe("ToolRegistry — decide_task", () => {
  it("approve transitions a review task to done", async () => {
    const { tools, ctx, tasks, workspaceId } = await setup();
    const { task } = await tasks.createTask({ workspaceId, title: "t" });
    await tasks.updateColumn(task.id, "running", "system");
    await tasks.onRunFinished(task.id, "succeeded");
    const out = (await tools.invoke(
      "decide_task",
      { taskId: task.id, decision: "approve" },
      ctx
    )) as { task: { column: string } };
    expect(out.task.column).toBe("done");
  });

  it("reject sets the rejected flag", async () => {
    const { tools, ctx, tasks, workspaceId } = await setup();
    const { task } = await tasks.createTask({ workspaceId, title: "t" });
    await tasks.updateColumn(task.id, "running", "system");
    await tasks.onRunFinished(task.id, "succeeded");
    const out = (await tools.invoke(
      "decide_task",
      { taskId: task.id, decision: "reject", reason: "no good" },
      ctx
    )) as { task: { column: string; rejected?: boolean } };
    expect(out.task.column).toBe("done");
    expect(out.task.rejected).toBe(true);
  });
});

describe("ToolRegistry — get_workspace_state", () => {
  it("returns tasks and plans scoped to the thread", async () => {
    const { tools, ctx, tasks, workspaceId } = await setup();
    await tasks.createTask({ workspaceId, title: "user-1", source: "user" });
    await tools.invoke(
      "propose_plan",
      { drafts: [{ title: "X", description: "" }] },
      ctx
    );
    const out = (await tools.invoke("get_workspace_state", {}, ctx)) as {
      tasks: Array<{ title: string }>;
      plans: Array<{ id: string }>;
    };
    expect(out.tasks.map((t) => t.title)).toContain("user-1");
    expect(out.plans).toHaveLength(1);
  });
});
