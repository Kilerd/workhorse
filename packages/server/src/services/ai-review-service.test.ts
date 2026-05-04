import { describe, expect, it, vi } from "vitest";

import type { GlobalSettings, Run, Task, Workspace, WorkspaceAgent } from "@workhorse/contracts";

import { AiReviewService } from "./ai-review-service.js";

const DEFAULT_SETTINGS: GlobalSettings = {
  language: "中文",
  openRouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    token: "",
    model: ""
  }
};

function createWorkspace(): Workspace {
  return {
    id: "workspace-1",
    name: "Repo",
    rootPath: "/tmp/workspace",
    isGitRepo: true,
    codexSettings: {
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write"
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createTask(): Task {
  return {
    id: "task-1",
    title: "Implement feature",
    description: "Add customizable workspace prompt templates.",
    workspaceId: "workspace-1",
    column: "running",
    order: 1024,
    dependencies: [],
    taskKind: "user",
    worktree: {
      baseRef: "origin/main",
      branchName: "task/task-1-implement-feature",
      path: "/tmp/task-1",
      status: "ready"
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createReviewerAgent(): WorkspaceAgent {
  const now = new Date().toISOString();
  return {
    id: "agent-reviewer-1",
    name: "Technical Reviewer",
    description: "Reviews engineering changes for correctness and test coverage.",
    role: "worker",
    runnerConfig: {
      type: "claude",
      prompt: "Review the current changes.",
      agent: "technical-reviewer"
    },
    createdAt: now,
    updatedAt: now
  };
}

function createReviewRun(summary?: string): Run {
  return {
    id: "run-review-1",
    taskId: "task-1",
    status: "succeeded",
    runnerType: "claude",
    command: "claude -p",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    logFile: "/tmp/run-review-1.log",
    metadata: summary
      ? {
          reviewSummary: summary
        }
      : undefined
  };
}

function createService(overrides?: {
  settings?: GlobalSettings;
  startTask?: ReturnType<typeof vi.fn>;
  workspace?: Workspace;
}) {
  const workspace = overrides?.workspace ?? createWorkspace();
  const startTask = (overrides?.startTask ??
    vi
      .fn<
        (
          taskId: string,
          options: Record<string, unknown>
        ) => Promise<{ task: Task; run: Run }>
      >()
      .mockResolvedValue({
        task: createTask(),
        run: createReviewRun()
      })) as ReturnType<typeof vi.fn<
    (
      taskId: string,
      options: Record<string, unknown>
    ) => Promise<{ task: Task; run: Run }>
  >>;

  return {
    service: new AiReviewService({
      store: {
        listWorkspaces: () => [workspace],
        listTasks: () => [],
        setTasks() {}
      } as never,
      events: {
        publish() {}
      } as never,
      gitWorktrees: {} as never,
      githubPullRequests: {} as never,
      startTask,
      appendAndPublishRunOutput: vi.fn(),
      updateRunMetadata: vi.fn(),
      refreshPullRequestSnapshot: vi.fn(async (task: Task) => task),
      getSettings: () => overrides?.settings ?? DEFAULT_SETTINGS,
      topOrder: () => 1024
    }),
    startTask
  };
}

describe("AiReviewService", () => {
  it("uses workspace review templates when building the reviewer prompt", () => {
    const task = {
      ...createTask(),
      pullRequestUrl: "https://github.com/acme/workhorse/pull/42",
      pullRequest: {
        title: "feat: add workspace prompt templates",
        reviewDecision: "CHANGES_REQUESTED",
        files: [
          {
            path: "packages/web/src/components/WorkspaceModals.tsx",
            additions: 220,
            deletions: 55
          }
        ]
      }
    } satisfies Task;
    const workspace = createWorkspace();
    const { service } = createService({ workspace });

    const config = service.buildManualReviewRunnerConfig(
      task,
      workspace,
      createReviewerAgent(),
      "technical correctness"
    );
    if (config.type !== "claude") {
      throw new Error("Expected Claude config");
    }

    expect(config.permissionMode).toBe("plan");
    expect(config.agent).toBe("technical-reviewer");
    expect(config.prompt).toContain("Review focus: technical correctness");
    expect(config.prompt).toContain('Review task "Implement feature"');
    expect(config.prompt).toContain("GitHub PR: https://github.com/acme/workhorse/pull/42");
    expect(config.prompt).toContain("Changed files snapshot:");
    expect(config.prompt).not.toContain("{{");
  });

  it("renders the built-in rework follow-up prompt when sending coding back for rework", async () => {
    const task = createTask();
    const reviewRun = createReviewRun(
      "Preview should render the effective template and variable hints need clearer wording."
    );
    const workspace = createWorkspace();
    const { service, startTask } = createService({ workspace });

    await service.triggerReworkFromReview(task, reviewRun);

    expect(startTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        initialInputText: [
          "The reviewer requested changes.",
          "",
          "Address the following feedback:",
          "",
          "Preview should render the effective template and variable hints need clearer wording."
        ].join("\n"),
        runMetadata: {
          trigger: "ai_review_rework",
          reviewRunId: "run-review-1"
        }
      })
    );
  });

});
