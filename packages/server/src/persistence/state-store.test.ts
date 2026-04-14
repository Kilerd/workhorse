import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  AccountAgent,
  AgentTeam,
  AppState,
  Run,
  Task,
  TaskMessage,
  TeamMessage,
  Workspace
} from "@workhorse/contracts";

import { StateStore } from "./state-store.js";

function makeWorkspace(): Workspace {
  const now = new Date().toISOString();
  return {
    id: "workspace-1",
    name: "Sample",
    rootPath: "/tmp/sample",
    isGitRepo: false,
    codexSettings: {
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write"
    },
    createdAt: now,
    updatedAt: now
  };
}

function makeTask(workspaceId: string): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    title: "Sample task",
    description: "",
    workspaceId,
    column: "backlog",
    order: 1_024,
    runnerType: "shell",
    runnerConfig: {
      type: "shell",
      command: "true"
    },
    dependencies: [],
    worktree: {
      baseRef: "main",
      branchName: "task-1",
      status: "not_created"
    },
    createdAt: now,
    updatedAt: now
  };
}

function makeRun(taskId: string, overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    taskId,
    status: "succeeded",
    runnerType: "shell",
    command: "true",
    startedAt: now,
    endedAt: now,
    logFile: `/tmp/${taskId}.log`,
    ...overrides
  };
}

describe("StateStore", () => {
  it("serializes concurrent task updates through the write lock", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    const task = makeTask(workspace.id);
    store.setWorkspaces([workspace]);
    store.setTasks([task]);
    await store.save();

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.updateTask(task.id, (current) => ({
          ...current,
          description: `${current.description}${index},`
        }))
      )
    );

    const updated = store.listTasks().find((entry) => entry.id === task.id);
    expect(updated?.description.split(",").filter(Boolean)).toHaveLength(20);
  });

  it("persists and reloads settings", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.setSettings({
      language: "English",
      openRouter: { baseUrl: "https://example.com", token: "tok", model: "gpt-4" },
      scheduler: { maxConcurrent: 5 }
    });
    await store.save();

    // Force a reload from SQLite to verify the data was actually persisted,
    // not just held in the in-memory buffer.
    (store as any).state = (store as any).readStateFromDb();

    const settings = store.getSettings();
    expect(settings.language).toBe("English");
    expect(settings.scheduler?.maxConcurrent).toBe(5);
  });

  it("persists tasks with dependencies", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    const task1 = makeTask(workspace.id);
    const task2: Task = { ...makeTask(workspace.id), id: "task-2", dependencies: ["task-1"] };
    store.setWorkspaces([workspace]);
    store.setTasks([task1, task2]);
    await store.save();

    const tasks = store.listTasks();
    const loaded2 = tasks.find((t) => t.id === "task-2");
    expect(loaded2?.dependencies).toEqual(["task-1"]);
  });

  it("prunes runs whose tasks have been removed before saving", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    const task = makeTask(workspace.id);
    const run = makeRun(task.id);
    store.setWorkspaces([workspace]);
    store.setTasks([task]);
    store.setRuns([run]);
    await store.save();

    store.setTasks([]);
    await store.save();

    expect(store.listRuns()).toEqual([]);
  });

  it("drops orphan runs and dependencies while migrating legacy JSON state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "workhorse-state-store-"));
    const workspace = makeWorkspace();
    const task = {
      ...makeTask(workspace.id),
      dependencies: ["task-missing"],
      lastRunId: "run-orphan",
      continuationRunId: "run-orphan"
    } satisfies Task;
    const legacyState = {
      schemaVersion: 6,
      settings: {
        language: "中文",
        openRouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          token: "",
          model: ""
        }
      },
      workspaces: [workspace],
      tasks: [task],
      runs: [
        makeRun(task.id, { id: "run-valid" }),
        makeRun("task-missing", { id: "run-orphan" })
      ]
    } satisfies AppState;

    await writeFile(
      join(dataDir, "state.json"),
      `${JSON.stringify(legacyState, null, 2)}\n`,
      "utf8"
    );

    const store = new StateStore(dataDir);
    await store.load();

    const snapshot = store.snapshot();
    expect(snapshot.runs.map((run) => run.id)).toEqual(["run-valid"]);
    expect(snapshot.tasks[0]?.dependencies).toEqual([]);
    expect(snapshot.tasks[0]?.lastRunId).toBeUndefined();
    expect(snapshot.tasks[0]?.continuationRunId).toBeUndefined();
  });

  it("persists cancelledAt on tasks", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    const cancelledAt = new Date().toISOString();
    const task = {
      ...makeTask(workspace.id),
      column: "done" as const,
      cancelledAt
    };
    store.setWorkspaces([workspace]);
    store.setTasks([task]);
    await store.save();

    const storeInternals = store as unknown as {
      state: unknown;
      readStateFromDb(): unknown;
    };
    storeInternals.state = storeInternals.readStateFromDb();

    expect(store.listTasks()[0]?.cancelledAt).toBe(cancelledAt);
  });

  it("appends and reads log entries", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const entry = {
      id: "entry-1",
      runId: "run-1",
      timestamp: new Date().toISOString(),
      stream: "stdout" as const,
      kind: "text" as const,
      text: "hello\n"
    };
    await store.appendLogEntry("run-1", entry);
    const entries = await store.readLogEntries("run-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("hello\n");
  });
});

function makeTeam(workspaceId: string, overrides: Partial<AgentTeam> = {}): AgentTeam {
  const now = new Date().toISOString();
  return {
    id: "team-1",
    name: "Test Team",
    description: "desc",
    workspaceId,
    agents: [
      { id: "agent-1", agentName: "Coordinator", role: "coordinator", runnerConfig: { type: "shell", command: "true" } },
      { id: "agent-2", agentName: "Worker", role: "worker", runnerConfig: { type: "shell", command: "true" } }
    ],
    prStrategy: "independent",
    autoApproveSubtasks: false,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("StateStore — Agent Teams", () => {
  it("creates and retrieves a team", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const team = makeTeam("ws-1");
    store.createTeam(team);

    const found = store.getTeam("team-1");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Test Team");
    expect(found?.prStrategy).toBe("independent");
    expect(found?.autoApproveSubtasks).toBe(false);
    expect(found?.agents).toHaveLength(2);
  });

  it("lists teams filtered by workspaceId", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createTeam(makeTeam("ws-1", { id: "team-1" }));
    store.createTeam(makeTeam("ws-2", { id: "team-2" }));

    expect(store.listTeams("ws-1")).toHaveLength(1);
    expect(store.listTeams("ws-2")).toHaveLength(1);
    expect(store.listTeams()).toHaveLength(2);
  });

  it("updates team fields including prStrategy", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createTeam(makeTeam("ws-1"));
    const updated = store.updateTeam("team-1", {
      name: "Renamed",
      prStrategy: "stacked",
      autoApproveSubtasks: true
    });

    expect(updated?.name).toBe("Renamed");
    expect(updated?.prStrategy).toBe("stacked");
    expect(updated?.autoApproveSubtasks).toBe(true);
  });

  it("deletes a team and returns true; returns false for missing team", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createTeam(makeTeam("ws-1"));
    expect(store.deleteTeam("team-1")).toBe(true);
    expect(store.getTeam("team-1")).toBeNull();
    expect(store.deleteTeam("team-1")).toBe(false);
  });

  it("appends and lists team messages", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createTeam(makeTeam("ws-1"));
    const now = new Date().toISOString();
    const msg: TeamMessage = {
      id: "msg-1",
      teamId: "team-1",
      parentTaskId: "task-parent",
      agentName: "Coordinator",
      senderType: "agent",
      messageType: "context",
      content: "hello",
      createdAt: now
    };
    store.appendTeamMessage(msg);
    const messages = store.listTeamMessages("team-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.senderType).toBe("agent");
    expect(messages[0]?.messageType).toBe("context");
    expect(messages[0]?.parentTaskId).toBe("task-parent");
    expect(messages[0]?.content).toBe("hello");
  });

  it("filters team messages by parentTaskId", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createTeam(makeTeam("ws-1"));
    const now = new Date().toISOString();
    store.appendTeamMessage({
      id: "msg-1",
      teamId: "team-1",
      parentTaskId: "task-parent-a",
      agentName: "Coordinator",
      senderType: "agent",
      messageType: "context",
      content: "plan a",
      createdAt: now
    });
    store.appendTeamMessage({
      id: "msg-2",
      teamId: "team-1",
      parentTaskId: "task-parent-b",
      agentName: "Coordinator",
      senderType: "agent",
      messageType: "status",
      content: "plan b",
      createdAt: now
    });

    expect(store.listTeamMessages("team-1", "task-parent-a")).toHaveLength(1);
    expect(store.listTeamMessages("team-1", "task-parent-b")).toHaveLength(1);
  });

  it("rejects messages exceeding 10KB", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createTeam(makeTeam("ws-1"));
    const now = new Date().toISOString();
    const msg: TeamMessage = {
      id: "msg-big",
      teamId: "team-1",
      parentTaskId: "task-parent",
      agentName: "Coordinator",
      senderType: "agent",
      messageType: "artifact",
      content: "x".repeat(10 * 1024 + 1),
      createdAt: now
    };
    expect(() => store.appendTeamMessage(msg)).toThrow("10KB");
  });

  it("cascades deletes team messages when team is deleted", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createTeam(makeTeam("ws-1"));
    const now = new Date().toISOString();
    store.appendTeamMessage({
      id: "msg-1",
      teamId: "team-1",
      parentTaskId: "task-parent",
      agentName: "Coordinator",
      senderType: "agent",
      messageType: "context",
      content: "hi",
      createdAt: now
    });
    expect(store.listTeamMessages("team-1")).toHaveLength(1);

    store.deleteTeam("team-1");
    // After team deletion, messages are cascade-deleted; re-creating will start fresh
    store.createTeam(makeTeam("ws-1"));
    expect(store.listTeamMessages("team-1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers for Phase 4 agent model tests
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AccountAgent> = {}): AccountAgent {
  const now = new Date().toISOString();
  return {
    id: "agent-a",
    name: "Test Agent",
    description: "desc",
    runnerConfig: { type: "shell", command: "true" },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeTaskMessage(parentTaskId: string, overrides: Partial<TaskMessage> = {}): TaskMessage {
  return {
    id: "msg-1",
    parentTaskId,
    agentName: "Agent",
    senderType: "agent",
    messageType: "context",
    content: "hello",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

describe("StateStore — Account Agents (Phase 4)", () => {
  it("creates and retrieves an agent", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const agent = makeAgent();
    store.createAgent(agent);

    const found = store.getAgent("agent-a");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Test Agent");
    expect(found?.runnerConfig).toEqual({ type: "shell", command: "true" });
  });

  it("lists all agents", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createAgent(makeAgent({ id: "agent-a" }));
    store.createAgent(makeAgent({ id: "agent-b", name: "Agent B" }));

    expect(store.listAgents()).toHaveLength(2);
  });

  it("updates agent fields", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createAgent(makeAgent());
    const updated = store.updateAgent("agent-a", {
      name: "Renamed",
      runnerConfig: { type: "shell", command: "echo updated" }
    });

    expect(updated?.name).toBe("Renamed");
    expect((updated?.runnerConfig as { command: string }).command).toBe("echo updated");
  });

  it("returns null when updating a non-existent agent", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    expect(store.updateAgent("missing", { name: "X" })).toBeNull();
  });

  it("deletes an agent and returns true; false for missing", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createAgent(makeAgent());
    expect(store.deleteAgent("agent-a")).toBe(true);
    expect(store.getAgent("agent-a")).toBeNull();
    expect(store.deleteAgent("agent-a")).toBe(false);
  });
});

async function storeWithWorkspace(): Promise<StateStore> {
  const store = new StateStore(":memory:");
  await store.load();
  store.setWorkspaces([makeWorkspace()]);
  await store.save();
  return store;
}

// "workspace-1" is the id produced by makeWorkspace()
const WS = "workspace-1";

describe("StateStore — Workspace Agent Mounting (Phase 4)", () => {
  it("mounts an agent to a workspace and lists it", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    const wa = store.mountAgentToWorkspace(WS, "agent-a", "worker");

    expect(wa.role).toBe("worker");
    expect(wa.name).toBe("Test Agent");

    const list = store.listWorkspaceAgents(WS);
    expect(list).toHaveLength(1);
    expect(list[0]?.role).toBe("worker");
  });

  it("retrieves a single workspace agent", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "coordinator");

    const wa = store.getWorkspaceAgent(WS, "agent-a");
    expect(wa?.role).toBe("coordinator");
    expect(store.getWorkspaceAgent(WS, "missing")).toBeNull();
  });

  it("unmounts an agent from a workspace", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "worker");

    expect(store.unmountAgentFromWorkspace(WS, "agent-a")).toBe(true);
    expect(store.listWorkspaceAgents(WS)).toHaveLength(0);
    expect(store.unmountAgentFromWorkspace(WS, "agent-a")).toBe(false);
  });

  it("updates workspace agent role", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "worker");

    const updated = store.updateWorkspaceAgentRole(WS, "agent-a", "coordinator");
    expect(updated?.role).toBe("coordinator");
  });

  it("returns null when updating role for unmounted agent", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    expect(store.updateWorkspaceAgentRole(WS, "agent-a", "worker")).toBeNull();
  });

  it("enforces single coordinator per workspace on mount", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent({ id: "agent-a" }));
    store.createAgent(makeAgent({ id: "agent-b", name: "Agent B" }));
    store.mountAgentToWorkspace(WS, "agent-a", "coordinator");

    expect(() => store.mountAgentToWorkspace(WS, "agent-b", "coordinator")).toThrow(
      "already has a coordinator"
    );
  });

  it("enforces single coordinator per workspace on role update", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent({ id: "agent-a" }));
    store.createAgent(makeAgent({ id: "agent-b", name: "Agent B" }));
    store.mountAgentToWorkspace(WS, "agent-a", "coordinator");
    store.mountAgentToWorkspace(WS, "agent-b", "worker");

    expect(() => store.updateWorkspaceAgentRole(WS, "agent-b", "coordinator")).toThrow(
      "already has a coordinator"
    );
  });

  it("allows re-assigning coordinator role to the same agent (idempotent)", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "coordinator");

    // updating the existing coordinator to coordinator again must succeed
    const updated = store.updateWorkspaceAgentRole(WS, "agent-a", "coordinator");
    expect(updated?.role).toBe("coordinator");
  });

  it("throws when mounting a missing agent", async () => {
    const store = await storeWithWorkspace();

    expect(() => store.mountAgentToWorkspace(WS, "ghost", "worker")).toThrow("Agent not found");
  });

  it("cascades workspace_agents deletion when agent is deleted", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "worker");
    expect(store.listWorkspaceAgents(WS)).toHaveLength(1);

    store.deleteAgent("agent-a");
    expect(store.listWorkspaceAgents(WS)).toHaveLength(0);
  });
});

describe("StateStore — Workspace Config (Phase 4)", () => {
  it("updates prStrategy and autoApproveSubtasks", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const ws = makeWorkspace();
    store.setWorkspaces([ws]);
    await store.save();

    const updated = store.updateWorkspaceConfig("workspace-1", {
      prStrategy: "stacked",
      autoApproveSubtasks: true
    });

    expect(updated?.prStrategy).toBe("stacked");
    expect(updated?.autoApproveSubtasks).toBe(true);
  });

  it("returns null for unknown workspaceId", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    expect(store.updateWorkspaceConfig("nope", { prStrategy: "single" })).toBeNull();
  });

  it("persists workspace config across reload", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const ws = makeWorkspace();
    store.setWorkspaces([ws]);
    await store.save();

    store.updateWorkspaceConfig("workspace-1", { prStrategy: "stacked", autoApproveSubtasks: true });

    // Force reload from DB
    (store as any).state = (store as any).readStateFromDb();
    const reloaded = store.listWorkspaces().find((w) => w.id === "workspace-1");
    expect(reloaded?.prStrategy).toBe("stacked");
    expect(reloaded?.autoApproveSubtasks).toBe(true);
  });
});

describe("StateStore — Task Messages (Phase 4)", () => {
  it("appends and lists task messages", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.appendTaskMessage(makeTaskMessage("parent-1"));
    const messages = store.listTaskMessages("parent-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("hello");
  });

  it("filters by parentTaskId", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.appendTaskMessage(makeTaskMessage("parent-a", { id: "msg-1" }));
    store.appendTaskMessage(makeTaskMessage("parent-b", { id: "msg-2" }));

    expect(store.listTaskMessages("parent-a")).toHaveLength(1);
    expect(store.listTaskMessages("parent-b")).toHaveLength(1);
  });

  it("rejects task messages exceeding 10KB", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    expect(() =>
      store.appendTaskMessage(
        makeTaskMessage("parent-1", { content: "x".repeat(10 * 1024 + 1) })
      )
    ).toThrow("10KB");
  });

  it("stores optional taskId and returns it", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.appendTaskMessage(makeTaskMessage("parent-1", { taskId: "subtask-1" }));
    const messages = store.listTaskMessages("parent-1");
    expect(messages[0]?.taskId).toBe("subtask-1");
  });
});
