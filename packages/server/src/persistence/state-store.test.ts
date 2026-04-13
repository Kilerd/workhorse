import { describe, expect, it } from "vitest";

import type { AgentTeam, Task, TeamMessage, Workspace } from "@workhorse/contracts";

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
