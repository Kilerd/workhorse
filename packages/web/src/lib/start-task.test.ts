import { describe, expect, it } from "vitest";

import type { Task } from "@workhorse/contracts";

import { applyOptimisticStartTask } from "./start-task";

function createTask(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Task",
    description: overrides.description ?? "",
    workspaceId: overrides.workspaceId ?? "workspace-1",
    column: overrides.column ?? "backlog",
    order: overrides.order ?? 1_024,
    runnerType: overrides.runnerType ?? "shell",
    runnerConfig: overrides.runnerConfig ?? {
      type: "shell",
      command: "true"
    },
    worktree: overrides.worktree ?? {
      baseRef: "origin/main",
      branchName: "task-1",
      status: "not_created"
    },
    lastRunId: overrides.lastRunId,
    pullRequestUrl: overrides.pullRequestUrl,
    pullRequest: overrides.pullRequest,
    createdAt: overrides.createdAt ?? "2026-04-02T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T00:00:00.000Z"
  };
}

describe("applyOptimisticStartTask", () => {
  it("moves tasks into running at the requested order", () => {
    const tasks = [
      createTask({ id: "running-1", column: "running", order: 1_024 }),
      createTask({ id: "backlog-1", column: "backlog", order: 4_096 })
    ];

    const updated = applyOptimisticStartTask(tasks, "backlog-1", { order: 2_048 });
    const startedTask = updated.find((task) => task.id === "backlog-1");

    expect(startedTask).toMatchObject({
      column: "running",
      order: 2_048
    });
  });

  it("moves tasks to the top of running when no order is provided", () => {
    const tasks = [
      createTask({ id: "running-1", column: "running", order: 1_024 }),
      createTask({ id: "running-2", column: "running", order: 2_048 }),
      createTask({ id: "review-1", column: "review", order: 512 })
    ];

    const updated = applyOptimisticStartTask(tasks, "review-1");
    const startedTask = updated.find((task) => task.id === "review-1");

    expect(startedTask).toMatchObject({
      column: "running",
      order: 0
    });
  });
});
