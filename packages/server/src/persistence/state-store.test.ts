import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    const dataDir = await mkdtemp(join(tmpdir(), "state-store-test-"));
    const store = new StateStore(dataDir);
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
});
