import type { RunStatus } from "@workhorse/contracts";
import { describe, expect, it } from "vitest";

import type { RunnerStartContext } from "./types.js";
import { ClaudeCliRunner } from "./claude-cli-runner.js";

function createClaudeContext(
  overrides: Partial<RunnerStartContext> = {}
): RunnerStartContext {
  return {
    run: {
      id: "run-claude-1",
      taskId: "task-claude-1",
      status: "queued",
      runnerType: "claude",
      command: "",
      startedAt: new Date().toISOString(),
      logFile: "/tmp/run-claude-1.log"
    },
    task: {
      id: "task-claude-1",
      title: "Review the task",
      description: "Inspect the changes and point out concrete issues.",
      workspaceId: "workspace-1",
      column: "review",
      order: 1024,
      runnerType: "claude",
      runnerConfig: {
        type: "claude",
        prompt: "Review the changes for regressions.",
        agent: "code-reviewer",
        permissionMode: "default"
      },
      dependencies: [],
      taskKind: "user",
      worktree: {
        baseRef: "origin/main",
        branchName: "task/task-claude-1-review-the-task",
        path: "/tmp/task-claude-1",
        status: "ready"
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    workspace: {
      id: "workspace-1",
      name: "Repo",
      rootPath: "/tmp/task-claude-1",
      isGitRepo: true,
      codexSettings: {
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write"
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    ...overrides
  };
}

describe("ClaudeCliRunner", () => {
  it("builds a stable Claude CLI command line for print-mode runs", () => {
    const runner = new ClaudeCliRunner();

    expect(
      runner.buildCommandArgs({
        type: "claude",
        prompt: "Review the changes.",
        agent: "code-reviewer",
        model: { mode: "custom", id: "claude-sonnet-4-6" },
        permissionMode: "plan"
      })
    ).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "plan",
      "--agent",
      "code-reviewer",
      "--model",
      "claude-sonnet-4-6"
    ]);
  });

  it("adds --effort for builtin Claude models and clamps xhigh to high", () => {
    const runner = new ClaudeCliRunner();
    expect(
      runner.buildCommandArgs({
        type: "claude",
        prompt: "Review the changes.",
        model: { mode: "builtin", id: "claude-sonnet-4-6", reasoningEffort: "high" }
      })
    ).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "default",
      "--model",
      "claude-sonnet-4-6",
      "--effort",
      "high"
    ]);

    expect(
      runner.buildCommandArgs({
        type: "claude",
        prompt: "Review the changes.",
        model: { mode: "builtin", id: "claude-sonnet-4-6", reasoningEffort: "xhigh" }
      })
    ).toContain("high");
  });

  it("includes task context and follow-up instructions in the prompt payload", () => {
    const runner = new ClaudeCliRunner();
    const prompt = runner.buildPrompt(
      createClaudeContext({
        inputText: "Focus on test coverage gaps."
      }),
      {
        type: "claude",
        prompt: "Review the changes for regressions."
      }
    );

    expect(prompt).toContain("Task: Review the task");
    expect(prompt).toContain("Task description:");
    expect(prompt).toContain("Inspect the changes and point out concrete issues.");
    expect(prompt).toContain("Instruction:");
    expect(prompt).toContain("Review the changes for regressions.");
    expect(prompt).toContain("Additional instruction:");
    expect(prompt).toContain("Focus on test coverage gaps.");
  });

  it("uses the raw workspace channel prompt for channel backing tasks", () => {
    const runner = new ClaudeCliRunner();
    const prompt = runner.buildPrompt(
      createClaudeContext({
        task: {
          ...createClaudeContext().task,
          taskKind: "channel_backing",
          title: "Workspace Coordinator",
          description: "Should not leak into the final prompt."
        }
      }),
      {
        type: "claude",
        prompt: "RAW #all PROMPT"
      }
    );

    expect(prompt).toBe("RAW #all PROMPT");
    expect(prompt).not.toContain("Task:");
    expect(prompt).not.toContain("Task description:");
    expect(prompt).not.toContain("Working directory:");
  });

  it("captures init metadata and emits assistant output from Claude stream-json events", async () => {
    const runner = new ClaudeCliRunner() as any;
    const output: Array<{ kind: string; title?: string; text: string }> = [];
    const state: {
      emittedAssistantTexts: Set<string>;
      finalStatus?: RunStatus;
      metadata: Record<string, string>;
    } = {
      emittedAssistantTexts: new Set<string>(),
      metadata: {}
    };
    const hooks = {
      async onOutput(entry: { kind: string; title?: string; text: string }) {
        output.push(entry);
      },
      async onExit() {}
    };

    await runner.handleParsedEvent(
      {
        type: "system",
        subtype: "init",
        session_id: "session-1",
        model: "claude-sonnet-4-6",
        permissionMode: "default"
      },
      hooks,
      state
    );
    await runner.handleParsedEvent(
      {
        type: "assistant",
        session_id: "session-1",
        message: {
          content: [
            {
              type: "text",
              text: "Not logged in · Please run /login"
            }
          ]
        },
        error: "authentication_failed"
      },
      hooks,
      state
    );
    await runner.handleParsedEvent(
      {
        type: "result",
        session_id: "session-1",
        is_error: true,
        result: "Not logged in · Please run /login",
        total_cost_usd: 0
      },
      hooks,
      state
    );

    expect(output[0]).toMatchObject({
      kind: "status",
      title: "Claude CLI initialized"
    });
    expect(output[1]).toMatchObject({
      kind: "agent",
      title: "Claude response",
      text: "Not logged in · Please run /login\n"
    });
    expect(output).toHaveLength(2);
    expect(state.metadata).toMatchObject({
      claudeSessionId: "session-1",
      claudeModel: "claude-sonnet-4-6",
      claudePermissionMode: "default",
      claudeTotalCostUsd: "0"
    });
    expect(state.finalStatus).toBe("failed");
  });

  it("extracts review verdict metadata from a structured JSON block", async () => {
    const runner = new ClaudeCliRunner() as any;
    const state: {
      emittedAssistantTexts: Set<string>;
      finalStatus?: RunStatus;
      metadata: Record<string, string>;
    } = {
      emittedAssistantTexts: new Set<string>(),
      metadata: {}
    };

    await runner.handleParsedEvent(
      {
        type: "assistant",
        session_id: "session-review-1",
        message: {
          content: [
            {
              type: "text",
              text: [
                "Blocking issue: the new cache invalidation path never clears stale entries.",
                "",
                "```json",
                '{"verdict":"request_changes","summary":"Refresh the cache invalidation path and add a regression test for stale reads."}',
                "```"
              ].join("\n")
            }
          ]
        }
      },
      {
        async onOutput() {},
        async onExit() {}
      },
      state
    );

    expect(state.metadata).toMatchObject({
      reviewVerdict: "request_changes",
      reviewSummary:
        "Refresh the cache invalidation path and add a regression test for stale reads."
    });
  });
});
