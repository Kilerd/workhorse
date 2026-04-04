import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import type { Task, Workspace } from "@workhorse/contracts";

import {
  createTaskWorktree,
  deriveTaskBranchName,
  deriveTaskWorktreePath
} from "./task-worktree.js";

const workspace: Workspace = {
  id: "workspace-1",
  name: "Repo",
  rootPath: "/tmp/workspace/repo",
  isGitRepo: true,
  codexSettings: {
    approvalPolicy: "never",
    sandboxMode: "workspace-write"
  },
  createdAt: "2026-04-04T00:00:00.000Z",
  updatedAt: "2026-04-04T00:00:00.000Z"
};

function createTask(overrides: Partial<Pick<Task, "id" | "title" | "worktree">> = {}) {
  return {
    id: overrides.id ?? "task-123",
    title: overrides.title ?? "Fix onboarding flow",
    worktree:
      overrides.worktree ??
      createTaskWorktree(overrides.id ?? "task-123", overrides.title ?? "Fix onboarding flow", {
        workspace
      })
  } satisfies Pick<Task, "id" | "title" | "worktree">;
}

describe("task worktree naming", () => {
  it("keeps the task id in standard task branch names", () => {
    expect(deriveTaskBranchName("task-123", "Fix onboarding flow")).toBe(
      "task/task-123-fix-onboarding-flow"
    );
  });

  it("omits the task id for AI-generated branch labels", () => {
    const worktree = createTaskWorktree("task-123", "修复引导流程", {
      workspace,
      branchLabel: "fix-onboarding-flow"
    });

    expect(worktree.branchName).toBe("task/fix-onboarding-flow");
  });

  it("uses the friendly directory name for AI-generated task branches", () => {
    const task = createTask({
      worktree: createTaskWorktree("task-123", "修复引导流程", {
        workspace,
        branchLabel: "fix-onboarding-flow"
      })
    });

    expect(basename(deriveTaskWorktreePath(workspace, task))).toBe("fix-onboarding-flow");
  });

  it("falls back to a task-id-prefixed directory name for colliding AI task branches", () => {
    const task = createTask({
      worktree: createTaskWorktree("task-123", "修复引导流程", {
        workspace,
        branchLabel: "fix-onboarding-flow"
      })
    });

    expect(
      basename(
        deriveTaskWorktreePath(workspace, task, {
          preserveAutoTaskId: true
        })
      )
    ).toBe("task-123-fix-onboarding-flow");
  });
});
