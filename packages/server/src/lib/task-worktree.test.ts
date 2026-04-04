import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import type { Task, Workspace } from "@workhorse/contracts";

import {
  createTaskWorktree,
  deriveTaskBranchName,
  deriveTaskBranchFallbackName,
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

  it("falls back to a task-id-prefixed branch name for colliding AI task branches", () => {
    const worktree = createTaskWorktree("task-123", "修复引导流程", {
      workspace,
      branchLabel: "fix-onboarding-flow",
      preserveAutoTaskId: true
    });

    expect(worktree.branchName).toBe("task/task-123-fix-onboarding-flow");
  });

  it("keeps standard task branch names stable when deriving fallback branch names", () => {
    expect(
      deriveTaskBranchFallbackName(
        "task/task-123-fix-onboarding-flow",
        "task-123",
        "Fix onboarding flow"
      )
    ).toBe("task/task-123-fix-onboarding-flow");
  });

  it("derives task-id-prefixed fallback branch names for friendly AI task branches", () => {
    expect(
      deriveTaskBranchFallbackName("task/fix-onboarding-flow", "task-123", "Fix onboarding flow")
    ).toBe("task/task-123-fix-onboarding-flow");
  });

  it("keeps UUID-length task ids consistent across collision fallback paths", () => {
    const taskId = "12345678-1234-1234-1234-123456789012";
    const branchLabel = "a".repeat(60);
    const expectedBranchName = `task/${taskId}-${"a".repeat(48)}`;

    expect(
      createTaskWorktree(taskId, "修复引导流程", {
        workspace,
        branchLabel,
        preserveAutoTaskId: true
      }).branchName
    ).toBe(expectedBranchName);
    expect(
      deriveTaskBranchFallbackName(`task/${branchLabel}`, taskId, "Fix onboarding flow")
    ).toBe(expectedBranchName);
  });

  it("ignores preserveAutoTaskId for non-task branches", () => {
    const task = createTask({
      worktree: {
        baseRef: "origin/main",
        branchName: "feature/fix-onboarding-flow",
        status: "not_created"
      }
    });

    expect(
      basename(
        deriveTaskWorktreePath(workspace, task, {
          preserveAutoTaskId: true
        })
      )
    ).toBe("fix-onboarding-flow");
  });

  it("uses the friendly directory name for standard task branches", () => {
    const task = createTask();

    expect(basename(deriveTaskWorktreePath(workspace, task))).toBe("fix-onboarding-flow");
  });

  it("preserves the task id in fallback directory names for standard task branches", () => {
    const task = createTask();

    expect(
      basename(
        deriveTaskWorktreePath(workspace, task, {
          preserveAutoTaskId: true
        })
      )
    ).toBe("task-123-fix-onboarding-flow");
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
