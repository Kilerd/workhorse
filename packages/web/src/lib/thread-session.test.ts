import { describe, expect, it } from "vitest";
import type {
  Task,
  Thread,
  Workspace,
  WorkspaceGitStatusData
} from "@workhorse/contracts";

import { resolveThreadSessionContext } from "./thread-session";

const WORKSPACE: Workspace = {
  id: "workspace-1",
  name: "Workhorse",
  rootPath: "/repo/workhorse",
  isGitRepo: true,
  codexSettings: {
    approvalPolicy: "never",
    sandboxMode: "workspace-write"
  },
  createdAt: "2026-04-24T00:00:00.000Z",
  updatedAt: "2026-04-24T00:00:00.000Z"
};

const COORDINATOR_THREAD: Thread = {
  id: "thread-coordinator",
  workspaceId: WORKSPACE.id,
  kind: "coordinator",
  coordinatorState: "running",
  createdAt: "2026-04-24T00:00:00.000Z"
};

const TASK_THREAD: Thread = {
  id: "thread-task",
  workspaceId: WORKSPACE.id,
  kind: "task",
  taskId: "task-1",
  coordinatorState: "idle",
  createdAt: "2026-04-24T00:00:00.000Z"
};

const TASK: Task = {
  id: "task-1",
  title: "Show thread session context",
  description: "",
  workspaceId: WORKSPACE.id,
  column: "todo",
  order: 0,
  runnerType: "codex",
  runnerConfig: {
    type: "codex",
    prompt: "Implement the UI change."
  },
  dependencies: [],
  worktree: {
    baseRef: "origin/main",
    branchName: "task/show-thread-session-context",
    path: "/tmp/workhorse-thread-context",
    status: "ready"
  },
  createdAt: "2026-04-24T00:00:00.000Z",
  updatedAt: "2026-04-24T00:00:00.000Z"
};

const GIT_STATUS: WorkspaceGitStatusData = {
  branch: "main",
  ahead: 0,
  behind: 0,
  changedFiles: 0,
  addedFiles: 0,
  deletedFiles: 0
};

describe("resolveThreadSessionContext", () => {
  it("uses the workspace root and git status branch for coordinator threads", () => {
    expect(
      resolveThreadSessionContext({
        thread: COORDINATOR_THREAD,
        workspace: WORKSPACE,
        workspaceGitStatus: GIT_STATUS
      })
    ).toEqual({
      worktreePath: "/repo/workhorse",
      branchName: "main"
    });
  });

  it("uses the task worktree path and branch for task threads", () => {
    expect(
      resolveThreadSessionContext({
        thread: TASK_THREAD,
        workspace: WORKSPACE,
        task: TASK
      })
    ).toEqual({
      worktreePath: "/tmp/workhorse-thread-context",
      branchName: "task/show-thread-session-context"
    });
  });

  it("keeps a task thread branch even when the worktree path is not created yet", () => {
    expect(
      resolveThreadSessionContext({
        thread: TASK_THREAD,
        workspace: WORKSPACE,
        task: {
          ...TASK,
          worktree: {
            ...TASK.worktree,
            path: undefined,
            status: "not_created"
          }
        }
      })
    ).toEqual({
      worktreePath: null,
      branchName: "task/show-thread-session-context"
    });
  });

  it("omits branch info for non-git workspaces", () => {
    expect(
      resolveThreadSessionContext({
        thread: COORDINATOR_THREAD,
        workspace: {
          ...WORKSPACE,
          isGitRepo: false
        },
        workspaceGitStatus: GIT_STATUS
      })
    ).toEqual({
      worktreePath: "/repo/workhorse",
      branchName: null
    });
  });
});
