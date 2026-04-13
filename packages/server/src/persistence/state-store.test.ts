import { describe, expect, it } from "vitest";

import type { Task, Workspace } from "@workhorse/contracts";

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
