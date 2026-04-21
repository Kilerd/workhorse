import { describe, expect, it } from "vitest";
import type { AgentTeam, WorkspaceAgent } from "@workhorse/contracts";

import {
  getCoordinationBadgeLabel,
  getTaskCoordinationScope,
  resolveCoordinationAgentName
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

describe("coordination helpers", () => {
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

  it("prefers the legacy team scope when a task still has teamId", () => {
    const scope = getTaskCoordinationScope(
      makeTask({ teamId: "team-1", parentTaskId: "parent-1" }),
      workspaceAgents
    );

    expect(scope).toEqual({
      kind: "legacy_team",
      teamId: "team-1",
      parentTaskId: "parent-1"
    });
  });

  it("uses the workspace scope for coordinator-backed parent tasks", () => {
    const scope = getTaskCoordinationScope(makeTask({}), workspaceAgents);

    expect(scope).toEqual({
      kind: "workspace",
      workspaceId: "ws-1",
      parentTaskId: "task-1"
    });
  });

  it("uses the workspace scope for workspace subtasks even without a teamId", () => {
    const scope = getTaskCoordinationScope(
      makeTask({ parentTaskId: "parent-1", teamAgentId: "agent-worker" }),
      []
    );

    expect(scope).toEqual({
      kind: "workspace",
      workspaceId: "ws-1",
      parentTaskId: "parent-1"
    });
  });

  it("returns none when a standalone task has no mounted coordinator", () => {
    expect(getTaskCoordinationScope(makeTask({}), [])).toEqual({ kind: "none" });
  });

  it("resolves assigned agent names from legacy teams and workspace agents", () => {
    const legacyTeam = {
      id: "team-1",
      agents: [
        {
          id: "legacy-worker",
          agentName: "Legacy Worker",
          role: "worker",
          runnerConfig: { type: "codex", prompt: "Build." }
        }
      ]
    } as AgentTeam;

    expect(
      resolveCoordinationAgentName({
        task: makeTask({ teamAgentId: "legacy-worker" }),
        legacyTeam
      })
    ).toBe("Legacy Worker");

    expect(
      resolveCoordinationAgentName({
        task: makeTask({ teamAgentId: "agent-worker" }),
        workspaceAgents
      })
    ).toBe("Worker");
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
});
