import { describe, expect, it } from "vitest";

import type { Thread, Workspace, WorkspaceAgent } from "@workhorse/contracts";

import { buildCoordinatorSystemPrompt } from "./coordinator-prompt.js";

function makeWorkspace(): Workspace {
  const now = new Date().toISOString();
  return {
    id: "ws-1",
    name: "Workhorse",
    rootPath: "/tmp/workhorse",
    isGitRepo: true,
    codexSettings: {
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write"
    },
    createdAt: now,
    updatedAt: now
  };
}

function makeThread(): Thread {
  return {
    id: "thread-1",
    workspaceId: "ws-1",
    kind: "coordinator",
    coordinatorAgentId: "agent-1",
    coordinatorState: "idle",
    createdAt: new Date().toISOString()
  };
}

function makeAgent(): WorkspaceAgent {
  const now = new Date().toISOString();
  return {
    id: "agent-1",
    name: "Settings worker",
    description: "Builds product settings UI",
    workspaceDescription: "Own workspace-agent description editing and tests.",
    role: "worker",
    runnerConfig: { type: "codex", prompt: "Do the assigned work." },
    createdAt: now,
    updatedAt: now
  };
}

describe("buildCoordinatorSystemPrompt", () => {
  it("includes both account and workspace agent descriptions", () => {
    const prompt = buildCoordinatorSystemPrompt({
      workspace: makeWorkspace(),
      thread: makeThread(),
      agents: [makeAgent()],
      tools: []
    });

    expect(prompt).toContain("Account capability: Builds product settings UI");
    expect(prompt).toContain(
      "Workspace instructions: Own workspace-agent description editing and tests."
    );
  });
});
