import { describe, expect, it } from "vitest";

import type { RunnerStartContext } from "./runners/types.js";
import { CodexAcpRunner } from "./runners/codex-acp-runner.js";

describe("CodexAcpRunner prompt", () => {
  it("tells git-backed tasks to create the PR themselves", () => {
    const runner = new CodexAcpRunner() as any;

    const prompt = runner.buildPrompt(
      {
        run: {
          id: "run-1",
          taskId: "task-1",
          status: "queued",
          runnerType: "codex",
          command: "",
          startedAt: new Date().toISOString(),
          logFile: "/tmp/run-1.log"
        },
        task: {
          id: "task-1",
          title: "Implement feature",
          description: "",
          workspaceId: "workspace-1",
          column: "todo",
          order: 1024,
          runnerType: "codex",
          runnerConfig: {
            type: "codex",
            prompt: "Implement the feature"
          },
          worktree: {
            baseRef: "origin/main",
            branchName: "task/task-1-implement-feature",
            path: "/tmp/task-1",
            status: "ready"
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        workspace: {
          id: "workspace-1",
          name: "Repo",
          rootPath: "/tmp/task-1",
          isGitRepo: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      {
        prompt: "Implement the feature"
      }
    );

    expect(prompt).toContain("opening or updating the GitHub PR yourself");
    expect(prompt).toContain("Use Conventional Commits");
    expect(prompt).toContain("Mention the PR URL in your final response");
  });
});
