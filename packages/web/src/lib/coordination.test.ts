import { describe, expect, it } from "vitest";
import type { WorkspaceAgent } from "@workhorse/contracts";

import {
  countWorkspaceWorkers,
  getCoordinationBadgeLabel,
  getCoordinatorWorkspaceAgent,
  hasWorkspaceCoordinator,
  resolveWorkspaceAgentName
} from "./coordination";
import type { DisplayTask } from "./task-view";

function makeTask(overrides: Partial<DisplayTask>): DisplayTask {
  return {
    id: "task-1",
    title: "Task",
    description: "",
    workspaceId: "ws-1",
    column: "todo",
    order: 1024,
    runnerType: "codex",
    runnerConfig: { type: "codex", prompt: "Do the work." },
    dependencies: [],
    worktree: {
      path: undefined,
      branchName: "feat/task-1",
      baseRef: "main",
      status: "not_created"
    },
    rejected: false,
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    ...overrides
  } as DisplayTask;
}

const workspaceAgents: WorkspaceAgent[] = [
  {
    id: "agent-coordinator",
    role: "coordinator",
    name: "Coordinator",
    description: "Owns delegation",
    runnerConfig: { type: "codex", prompt: "Coordinate." },
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z"
  },
  {
    id: "agent-worker",
    role: "worker",
    name: "Worker",
    description: "Builds things",
    runnerConfig: { type: "codex", prompt: "Build." },
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z"
  }
];

describe("coordination helpers", () => {
  it("finds the mounted coordinator agent", () => {
    expect(getCoordinatorWorkspaceAgent(workspaceAgents)?.id).toBe("agent-coordinator");
    expect(getCoordinatorWorkspaceAgent([])).toBeNull();
  });

  it("reports whether a workspace has a coordinator", () => {
    expect(hasWorkspaceCoordinator(workspaceAgents)).toBe(true);
    expect(hasWorkspaceCoordinator([])).toBe(false);
  });

  it("counts worker agents", () => {
    expect(countWorkspaceWorkers(workspaceAgents)).toBe(1);
    expect(countWorkspaceWorkers([])).toBe(0);
  });

  it("resolves the assigned agent name from workspace agents", () => {
    expect(
      resolveWorkspaceAgentName(
        makeTask({ assigneeAgentId: "agent-worker" }),
        workspaceAgents
      )
    ).toBe("Worker");
    expect(
      resolveWorkspaceAgentName(
        makeTask({ assigneeAgentId: "agent-coordinator" }),
        workspaceAgents
      )
    ).toBe("Coordinator");
    expect(resolveWorkspaceAgentName(makeTask({}), workspaceAgents)).toBeNull();
  });

  it("labels workspace-backed parent tasks with an agents badge", () => {
    const label = getCoordinationBadgeLabel({
      task: makeTask({}),
      workspace: {
        id: "ws-1",
        name: "Acme",
        rootPath: "/tmp/acme",
        isGitRepo: false,
        codexSettings: {
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write"
        },
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z"
      },
      workspaceAgents
    });

    expect(label).toBe("Agents · Acme");
  });

  it("omits the badge when the task is a subtask", () => {
    const label = getCoordinationBadgeLabel({
      task: makeTask({ parentTaskId: "parent-1" }),
      workspace: null,
      workspaceAgents
    });

    expect(label).toBeNull();
  });

  it("omits the badge when the workspace has no coordinator", () => {
    const label = getCoordinationBadgeLabel({
      task: makeTask({}),
      workspace: null,
      workspaceAgents: []
    });

    expect(label).toBeNull();
  });
});
