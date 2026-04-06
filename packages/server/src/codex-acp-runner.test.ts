import { describe, expect, it } from "vitest";

import { extractGitHubPullRequestUrl } from "./lib/github.js";
import type { RunnerStartContext } from "./runners/types.js";
import {
  classifyItemLifecycle,
  CodexAcpRunner
} from "./runners/codex-acp-runner.js";

function createCodexContext(overrides: Partial<RunnerStartContext> = {}): RunnerStartContext {
  return {
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

describe("CodexAcpRunner prompt", () => {
  it("tells git-backed tasks to create the PR themselves", () => {
    const runner = new CodexAcpRunner() as any;
    const prompt = runner.buildPrompt(createCodexContext(), {
      prompt: "Implement the feature"
    });

    expect(prompt).toContain("opening or updating the GitHub PR yourself");
    expect(prompt).toContain("Use Conventional Commits");
    expect(prompt).toContain("Mention the PR URL in your final response");
  });

  it("attaches the latest pull request url found in captured output", () => {
    const runner = new CodexAcpRunner() as any;

    const metadata = runner.attachPullRequestMetadata(
      {
        threadId: "thread-1"
      },
      [
        "Created PR https://github.com/acme/widgets/pull/17",
        "Final response: https://github.com/acme/widgets/pull/18."
      ]
    );

    expect(metadata).toEqual({
      threadId: "thread-1",
      prUrl: "https://github.com/acme/widgets/pull/18"
    });
  });

  it("includes the task description as prompt context when present", () => {
    const runner = new CodexAcpRunner() as any;
    const prompt = runner.buildPrompt(
      createCodexContext({
        run: {
          id: "run-2",
          taskId: "task-2",
          status: "queued",
          runnerType: "codex",
          command: "",
          startedAt: new Date().toISOString(),
          logFile: "/tmp/run-2.log"
        },
        task: {
          ...createCodexContext().task,
          id: "task-2",
          description: "Need to update the onboarding flow and keep tests green."
        },
        workspace: {
          ...createCodexContext().workspace,
          rootPath: "/tmp/task-2",
          isGitRepo: false
        }
      }),
      {
        prompt: "Implement the feature"
      }
    );

    expect(prompt).toContain("Task description:");
    expect(prompt).toContain("Need to update the onboarding flow and keep tests green.");
  });

  it("uses workspace coding templates when present", () => {
    const runner = new CodexAcpRunner() as any;
    const prompt = runner.buildPrompt(
      createCodexContext({
        workspace: {
          ...createCodexContext().workspace,
          promptTemplates: {
            coding: [
              "Custom coding wrapper",
              "Prompt: {{taskPrompt}}",
              "Branch: {{branchName}}"
            ].join("\n")
          }
        }
      }),
      {
        prompt: "Implement the feature"
      }
    );

    expect(prompt).toContain("Custom coding wrapper");
    expect(prompt).toContain("Prompt: Implement the feature");
    expect(prompt).toContain("Branch: task/task-1-implement-feature");
    expect(prompt).not.toContain("Git requirements:");
  });

  it("does not duplicate task context when a custom coding template renders it explicitly", () => {
    const runner = new CodexAcpRunner() as any;
    const prompt = runner.buildPrompt(
      createCodexContext({
        task: {
          ...createCodexContext().task,
          description: "Need to update the onboarding flow and keep tests green.",
          plan: "1. Update the flow\n2. Keep tests green"
        },
        workspace: {
          ...createCodexContext().workspace,
          promptTemplates: {
            coding: [
              "Task: {{taskTitle}}",
              "{{taskDescriptionBlock}}",
              "{{taskPlanBlock}}",
              "{{taskPrompt}}"
            ].join("\n\n")
          }
        }
      }),
      {
        prompt: "Implement the feature"
      }
    );

    expect(prompt.match(/Task: Implement feature/g)).toHaveLength(1);
    expect(prompt.match(/Task description:/g)).toHaveLength(1);
    expect(prompt.match(/Implementation plan:/g)).toHaveLength(1);
  });

  it("starts persistent threads so they can be resumed later", () => {
    const runner = new CodexAcpRunner() as any;

    const params = runner.buildThreadStartParams(createCodexContext(), {
      prompt: "Implement the feature"
    });

    expect(params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
  });

  it("uses workspace codex settings when starting a thread", () => {
    const runner = new CodexAcpRunner() as any;

    const params = runner.buildThreadStartParams(
      createCodexContext({
        workspace: {
          ...createCodexContext().workspace,
          codexSettings: {
            approvalPolicy: "untrusted",
            sandboxMode: "read-only"
          }
        }
      }),
      {
        prompt: "Implement the feature"
      }
    );

    expect(params).toMatchObject({
      approvalPolicy: "untrusted",
      sandbox: "read-only"
    });
  });

  it("uses the raw follow-up text when continuing on a resumed thread", () => {
    const runner = new CodexAcpRunner() as any;
    const context = createCodexContext({
      inputText: "Please address the review comments."
    });

    const params = runner.buildTurnStartParams(
      context,
      {
        prompt: "Implement the feature"
      },
      "thread-1",
      true
    );

    expect(params).toMatchObject({
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text: "Please address the review comments."
        }
      ]
    });
  });

  it("falls back to task context plus follow-up text when no thread was resumed", () => {
    const runner = new CodexAcpRunner() as any;
    const context = createCodexContext({
      inputText: "Please address the review comments."
    });

    const params = runner.buildTurnStartParams(
      context,
      {
        prompt: "Implement the feature"
      },
      "thread-2",
      false
    );

    expect(params.threadId).toBe("thread-2");
    expect(params.input[0]?.text).toContain("Task: Implement feature");
    expect(params.input[0]?.text).toContain("Implement the feature");
    expect(params.input[0]?.text).toContain("User follow-up:");
    expect(params.input[0]?.text).toContain("Please address the review comments.");
  });

  it("resumes the previous codex thread when a thread id is available", () => {
    const runner = new CodexAcpRunner() as any;

    const threadId = runner.resolvePreviousThreadId(
      createCodexContext({
        previousRun: {
          id: "run-previous",
          taskId: "task-1",
          status: "interrupted",
          runnerType: "codex",
          command: "codex app-server --listen ws://127.0.0.1:9000",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          logFile: "/tmp/run-previous.log",
          metadata: {
            threadId: "thread-1",
            turnId: "turn-1"
          }
        }
      })
    );

    expect(threadId).toBe("thread-1");
  });

  it("ignores non-codex previous runs when checking for a resumable thread", () => {
    const runner = new CodexAcpRunner() as any;

    const threadId = runner.resolvePreviousThreadId(
      createCodexContext({
        previousRun: {
          id: "run-previous",
          taskId: "task-1",
          status: "succeeded",
          runnerType: "shell",
          command: "true",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          logFile: "/tmp/run-previous.log",
          metadata: {
            threadId: "thread-1"
          }
        }
      })
    );

    expect(threadId).toBeNull();
  });
});

describe("extractGitHubPullRequestUrl", () => {
  it("returns the latest pull request url and strips trailing punctuation", () => {
    const url = extractGitHubPullRequestUrl(
      [
        "First draft: https://github.com/acme/widgets/pull/17",
        "Ready now: https://github.com/acme/widgets/pull/18."
      ].join("\n")
    );

    expect(url).toBe("https://github.com/acme/widgets/pull/18");
  });
});

describe("classifyItemLifecycle", () => {
  it("does not emit a placeholder when an agent message starts", () => {
    const output = classifyItemLifecycle(
      {
        id: "item-1",
        type: "assistantMessage",
        text: "Draft response"
      },
      "started",
      {
        threadId: "thread-1",
        turnId: "turn-1"
      }
    );

    expect(output).toBeNull();
  });

  it("skips duplicate agent lifecycle output after streaming deltas", () => {
    const output = classifyItemLifecycle(
      {
        id: "item-1",
        type: "assistantMessage",
        text: "Draft response"
      },
      "completed",
      {
        threadId: "thread-1",
        turnId: "turn-1"
      },
      {
        skipAgentLifecycle: true
      }
    );

    expect(output).toBeNull();
  });

  it("keeps completed agent lifecycle output as a fallback when no deltas were streamed", () => {
    const output = classifyItemLifecycle(
      {
        id: "item-1",
        type: "assistantMessage",
        text: "Final response"
      },
      "completed",
      {
        threadId: "thread-1",
        turnId: "turn-1"
      }
    );

    expect(output).toMatchObject({
      kind: "agent",
      title: "Agent response",
      text: "Final response"
    });
  });

  it("keeps command lifecycle summaries focused on the command instead of aggregated output", () => {
    const output = classifyItemLifecycle(
      {
        id: "item-1",
        type: "commandExecution",
        command: "/bin/zsh -lc 'gh pr view --json url'",
        aggregatedOutput: "unknown flag: --head\nUsage: gh pr view ...",
        status: "failed",
        exitCode: 1
      },
      "completed",
      {
        threadId: "thread-1",
        turnId: "turn-1"
      }
    );

    expect(output).toMatchObject({
      kind: "tool_call",
      title: "Command Execution completed",
      text: "/bin/zsh -lc 'gh pr view --json url'",
      metadata: {
        itemType: "commandExecution",
        status: "failed",
        exitCode: "1"
      }
    });
    expect(output?.text).not.toContain("unknown flag");
  });
});
