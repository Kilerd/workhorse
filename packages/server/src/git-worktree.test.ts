import { execFile } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { Run } from "@workhorse/contracts";

import { createApp } from "./app.js";
import type {
  GitHubPullRequestCheck,
  GitHubPullRequestProvider,
  GitHubPullRequestSummary
} from "./lib/github.js";
import { StateStore } from "./persistence/state-store.js";
import type { RunnerAdapter, RunnerControl, RunnerLifecycleHooks, RunnerStartContext } from "./runners/types.js";
import { BoardService } from "./services/board-service.js";
import type { TaskIdentityGenerator } from "./services/openrouter-task-naming-service.js";
import { EventBus } from "./ws/event-bus.js";

class MockClaudeRunner implements RunnerAdapter {
  public readonly type = "claude" as const;
  public async start(
    context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl> {
    const planText = "# Plan\n\nMock plan for testing.";
    setTimeout(async () => {
      await hooks.onOutput({
        kind: "agent",
        text: planText,
        stream: "stdout",
        title: "Claude response",
        source: "Claude CLI"
      });
      await hooks.onExit({ status: "succeeded", exitCode: 0, metadata: { claudeSessionId: "mock-session" } });
    }, 10);
    return {
      command: "claude (mock)",
      metadata: { claudeSessionId: "mock-session" },
      async stop() {}
    };
  }
}

class MockCodexRunner implements RunnerAdapter {
  public readonly type = "codex" as const;

  public async start(
    context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl> {
    const command = context.task.description.trim();
    const metadata = context.run.metadata ?? {};
    setTimeout(async () => {
      if (!command || metadata.trigger === "plan_generation") {
        await hooks.onOutput({
          kind: "agent",
          text: "# Plan\n\nMock plan for testing.",
          stream: "stdout",
          title: "Codex response",
          source: "Codex"
        });
        await hooks.onExit({
          status: "succeeded",
          exitCode: 0,
          metadata: { threadId: "mock-thread" }
        });
        return;
      }

      try {
        if (metadata.trigger === "gh_pr_monitor") {
          const baseRef = context.task.worktree.baseRef || "origin/main";
          const rebase = await execFileAsync("git", ["rebase", baseRef], {
            cwd: context.workspace.rootPath,
            encoding: "utf8"
          });
          if (rebase.stdout) {
            await hooks.onOutput({
              kind: "text",
              text: rebase.stdout,
              stream: "stdout"
            });
          }
          if (rebase.stderr) {
            await hooks.onOutput({
              kind: "text",
              text: rebase.stderr,
              stream: "stderr"
            });
          }
        }

        const result = await execFileAsync("/bin/zsh", ["-lc", command], {
          cwd: context.workspace.rootPath,
          encoding: "utf8"
        });
        if (result.stdout) {
          await hooks.onOutput({
            kind: "text",
            text: result.stdout,
            stream: "stdout"
          });
        }
        if (result.stderr) {
          await hooks.onOutput({
            kind: "text",
            text: result.stderr,
            stream: "stderr"
          });
        }
        await hooks.onExit({
          status: "succeeded",
          exitCode: 0,
          metadata: { threadId: "mock-thread" }
        });
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string; code?: number };
        if (failed.stdout) {
          await hooks.onOutput({
            kind: "text",
            text: failed.stdout,
            stream: "stdout"
          });
        }
        if (failed.stderr) {
          await hooks.onOutput({
            kind: "text",
            text: failed.stderr,
            stream: "stderr"
          });
        }
        await hooks.onExit({
          status: "failed",
          exitCode: typeof failed.code === "number" ? failed.code : 1,
          metadata: { threadId: "mock-thread" }
        });
      }
    }, 10);

    return {
      command: command || "codex mock",
      metadata: { threadId: "mock-thread" },
      async stop() {}
    };
  }
}

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8"
  });
  return result.stdout.trim();
}

async function createGitRepository(rootDir: string) {
  const remoteDir = join(rootDir, "remote.git");
  const seedDir = join(rootDir, "seed");
  const workspaceDir = join(rootDir, "workspace");

  await runGit(["init", "--bare", remoteDir]);
  await runGit(["-C", remoteDir, "symbolic-ref", "HEAD", "refs/heads/main"]);

  await runGit(["init", "--initial-branch=main", seedDir]);
  await runGit(["-C", seedDir, "config", "user.name", "Workhorse Test"]);
  await runGit(["-C", seedDir, "config", "user.email", "workhorse@example.com"]);
  await writeFile(join(seedDir, "marker.txt"), "v1\n", "utf8");
  await runGit(["-C", seedDir, "add", "marker.txt"]);
  await runGit(["-C", seedDir, "commit", "-m", "feat: initial commit"]);
  await runGit(["-C", seedDir, "remote", "add", "origin", remoteDir]);
  await runGit(["-C", seedDir, "push", "-u", "origin", "main"]);

  await runGit(["clone", remoteDir, workspaceDir]);
  await runGit(["-C", workspaceDir, "config", "user.name", "Workhorse Test"]);
  await runGit(["-C", workspaceDir, "config", "user.email", "workhorse@example.com"]);
  await runGit([
    "-C",
    workspaceDir,
    "remote",
    "add",
    "github",
    "git@github.com:workhorse-git-test/remote.git"
  ]);

  return {
    remoteDir,
    seedDir,
    workspaceDir
  };
}

async function pushMarkerUpdate(seedDir: string, text: string): Promise<void> {
  await writeFile(join(seedDir, "marker.txt"), `${text}\n`, "utf8");
  await runGit(["-C", seedDir, "add", "marker.txt"]);
  await runGit(["-C", seedDir, "commit", "-m", `feat: ${text}`]);
  await runGit(["-C", seedDir, "push", "origin", "main"]);
}

async function createGitRuntime() {
  return createGitRuntimeWithOptions();
}

async function createGitRuntimeWithOptions(options: {
  taskIdentityGenerator?: TaskIdentityGenerator;
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "workhorse-git-test-"));
  const gitRepo = await createGitRepository(dataDir);
  const service = new BoardService(new StateStore(dataDir), new EventBus(), {
    taskIdentityGenerator: options.taskIdentityGenerator,
    runners: {
      claude: new MockClaudeRunner(),
      codex: new MockCodexRunner()
    }
  });
  await service.initialize();

  return {
    app: createApp(service),
    dataDir,
    service,
    ...gitRepo
  };
}

async function createGitRuntimeWithProvider(githubPullRequests: GitHubPullRequestProvider) {
  const dataDir = await mkdtemp(join(tmpdir(), "workhorse-git-test-"));
  const gitRepo = await createGitRepository(dataDir);
  const service = new BoardService(new StateStore(dataDir), new EventBus(), {
    githubPullRequests,
    runners: {
      claude: new MockClaudeRunner(),
      codex: new MockCodexRunner()
    }
  });
  await service.initialize();

  return {
    app: createApp(service),
    dataDir,
    service,
    ...gitRepo
  };
}

function createTaskIdentityGeneratorStub(
  result = {
    title: "Fix onboarding flow",
    worktreeName: "fix-onboarding-flow"
  }
): TaskIdentityGenerator {
  return {
    async generate() {
      return result;
    }
  };
}

async function createGitWorkspace(service: BoardService, workspaceDir: string, name = "Repo") {
  const workspace = await service.createWorkspace({
    name,
    rootPath: workspaceDir
  });
  const agent = service.createAgent({
    name: `${name} Worker`,
    description: "Runs worktree-backed test tasks.",
    runnerConfig: {
      type: "codex",
      prompt: "Run the assigned worktree task.",
      approvalMode: "default"
    }
  });
  service.mountAgent(workspace.id, { agentId: agent.id, role: "worker" });
  return workspace;
}

async function createGitTask(
  service: BoardService,
  workspaceId: string,
  overrides: Partial<{
    title: string;
    command: string;
    worktreeBaseRef: string;
  }> = {}
) {
  return service.createTask({
    title: overrides.title ?? "Git task",
    workspaceId,
    description:
      overrides.command ??
      "node -e \"const fs=require('fs'); console.log(process.cwd()); console.log(fs.readFileSync('marker.txt','utf8').trim())\"",
    worktreeBaseRef: overrides.worktreeBaseRef
  });
}

async function waitForRunToFinish(
  service: BoardService,
  taskId: string,
  timeoutMs = 5_000
): Promise<Run> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const run = service.listRuns(taskId)[0];
    if (run?.endedAt) {
      return run;
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for run ${taskId} to finish`);
}

async function waitForRunIdToFinish(
  service: BoardService,
  taskId: string,
  runId: string,
  timeoutMs = 5_000
): Promise<Run> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const run = service.listRuns(taskId).find((entry) => entry.id === runId);
    if (run?.endedAt) {
      return run;
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

async function waitForTriggeredRunToFinish(
  service: BoardService,
  taskId: string,
  trigger: string,
  previousStartedAt?: string,
  timeoutMs = 5_000
): Promise<Run> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const run = service
      .listRuns(taskId)
      .find(
        (entry) =>
          entry.metadata?.trigger === trigger &&
          (!previousStartedAt || entry.startedAt !== previousStartedAt)
      );
    if (run?.endedAt) {
      return run;
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for ${trigger} run on task ${taskId}`);
}

async function waitForTaskColumn(
  service: BoardService,
  taskId: string,
  column: string,
  timeoutMs = 5_000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const task = service.listTasks({}).find((entry) => entry.id === taskId);
    if (task?.column === column) {
      return;
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for task ${taskId} to reach ${column}`);
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }

  throw new Error(message);
}

async function commitAndPushTaskBranch(
  worktreePath: string,
  fileName: string,
  content: string,
  message: string
): Promise<string> {
  await writeFile(join(worktreePath, fileName), `${content}\n`, "utf8");
  await runGit(["-C", worktreePath, "add", fileName]);
  await runGit(["-C", worktreePath, "commit", "-m", message]);
  await runGit(["-C", worktreePath, "push", "-u", "origin", "HEAD"]);
  return runGit(["-C", worktreePath, "rev-parse", "HEAD"]);
}

async function mergeBranchIntoMain(
  seedDir: string,
  branchName: string,
  message: string
): Promise<string> {
  await runGit(["-C", seedDir, "fetch", "origin", branchName]);
  await runGit(["-C", seedDir, "checkout", "main"]);
  await runGit(["-C", seedDir, "merge", "--no-ff", `origin/${branchName}`, "-m", message]);
  await runGit(["-C", seedDir, "push", "origin", "main"]);
  return runGit(["-C", seedDir, "rev-parse", "HEAD"]);
}

function createFakeGitHubProvider() {
  const openPullRequests = new Map<string, GitHubPullRequestSummary>();
  const mergedPullRequests = new Map<string, GitHubPullRequestSummary>();
  const checks = new Map<string, GitHubPullRequestCheck[]>();
  const comments: Array<{
    repositoryFullName: string;
    pullRequest: number | string;
    body: string;
  }> = [];
  const reviews: Array<{
    repositoryFullName: string;
    pullRequest: number | string;
    action: "approve" | "comment" | "request_changes";
    body: string;
  }> = [];

  const provider: GitHubPullRequestProvider = {
    async isAvailable() {
      return true;
    },
    async findOpenPullRequest(repositoryFullName, headRef) {
      return openPullRequests.get(`${repositoryFullName}:${headRef}`) ?? null;
    },
    async findMergedPullRequest(repositoryFullName, headRef) {
      return mergedPullRequests.get(`${repositoryFullName}:${headRef}`) ?? null;
    },
    async listRequiredChecks(repositoryFullName, pullRequest) {
      return checks.get(`${repositoryFullName}:${String(pullRequest)}`) ?? [];
    },
    async addPullRequestComment(repositoryFullName, pullRequest, body) {
      comments.push({
        repositoryFullName,
        pullRequest,
        body
      });
    },
    async submitPullRequestReview(repositoryFullName, pullRequest, action, body) {
      reviews.push({
        repositoryFullName,
        pullRequest,
        action,
        body
      });
    }
  };

  return {
    provider,
    setOpenPullRequest(
      repositoryFullName: string,
      headRef: string,
      pr: GitHubPullRequestSummary
    ) {
      openPullRequests.set(`${repositoryFullName}:${headRef}`, pr);
    },
    setMergedPullRequest(
      repositoryFullName: string,
      headRef: string,
      pr: GitHubPullRequestSummary
    ) {
      mergedPullRequests.set(`${repositoryFullName}:${headRef}`, pr);
    },
    setChecks(repositoryFullName: string, pullRequestNumber: number, value: GitHubPullRequestCheck[]) {
      checks.set(`${repositoryFullName}:${String(pullRequestNumber)}`, value);
    },
    comments,
    reviews
  };
}

describe("git worktree lifecycle", () => {
  it("migrates schema version 1 state by adding task worktree metadata", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "workhorse-migrate-test-"));
    const { workspaceDir } = await createGitRepository(dataDir);
    const stateFile = join(dataDir, "state.json");
    const oldState = {
      schemaVersion: 1,
      workspaces: [
        {
          id: "workspace-1",
          name: "Repo",
          rootPath: workspaceDir,
          isGitRepo: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      tasks: [
        {
          id: "task-1",
          title: "Add worktree",
          description: "",
          workspaceId: "workspace-1",
          column: "backlog",
          order: 1024,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      runs: []
    };

    await writeFile(stateFile, `${JSON.stringify(oldState, null, 2)}\n`, "utf8");

    const store = new StateStore(dataDir);
    await store.load();
    const snapshot = store.snapshot();

    expect(snapshot.schemaVersion).toBe(9);
    expect(snapshot.settings).toEqual({
      language: "中文",
      openRouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        token: "",
        model: ""
      }
    });
    expect(snapshot.workspaces[0]?.codexSettings).toEqual({
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write"
    });
    expect(snapshot.tasks[0]?.worktree.baseRef).toBe("origin/main");
    expect(snapshot.tasks[0]?.worktree.status).toBe("not_created");
    expect(snapshot.tasks[0]?.worktree.branchName).toContain("task-1");
  });

  it("creates git task metadata without creating a worktree directory", async () => {
    const { service, workspaceDir } = await createGitRuntime();
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id);

    expect(task.worktree.status).toBe("not_created");
    expect(task.worktree.baseRef).toBe("origin/main");
    expect(task.worktree.path).toBeUndefined();

    const worktreeList = await runGit(["-C", workspaceDir, "worktree", "list", "--porcelain"]);
    const registeredPaths = worktreeList
      .split("\n")
      .filter((line) => line.startsWith("worktree "));

    expect(registeredPaths).toHaveLength(1);
  });

  it("lists git refs over HTTP and marks origin/main as default", async () => {
    const { app, service, workspaceDir } = await createGitRuntime();
    const workspace = await createGitWorkspace(service, workspaceDir);

    const response = await app.request(`/api/workspaces/${workspace.id}/git/refs`);
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.ok).toBe(true);
    expect(payload.data.items.some((item: { name: string; isDefault: boolean }) =>
      item.name === "origin/main" && item.isDefault
    )).toBe(true);
  });

  it("plans a task by creating its worktree and moving it to todo", async () => {
    const { service, workspaceDir } = await createGitRuntime();
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id);

    const result = await service.planTask(task.id);
    await waitForRunToFinish(service, task.id);
    const updatedTask = service.listTasks({}).find((entry) => entry.id === task.id)!;

    expect(updatedTask.column).toBe("todo");
    expect(updatedTask.worktree.status).toBe("ready");
    expect(updatedTask.worktree.path).toBeTruthy();
    expect(await readFile(join(updatedTask.worktree.path!, "marker.txt"), "utf8")).toContain("v1");
    expect(await runGit(["-C", updatedTask.worktree.path!, "rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      updatedTask.worktree.branchName
    );
  });

  it("uses UUID-free worktree directory names for auto-generated task branches", async () => {
    const { service, workspaceDir } = await createGitRuntime();
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id, {
      title: "Remove auto worktree UUID"
    });

    await service.planTask(task.id);
    await waitForRunToFinish(service, task.id);
    const updatedTask = service.listTasks({}).find((entry) => entry.id === task.id)!;
    const worktreePath = updatedTask.worktree.path;

    if (!worktreePath) {
      throw new Error("Expected planned task to create a worktree path");
    }

    expect(basename(worktreePath)).toBe("remove-auto-worktree-uuid");
    expect(basename(worktreePath)).not.toContain(task.id);
    expect(updatedTask.worktree.branchName).toContain(task.id);
  });

  it("falls back to the UUID-prefixed directory name when the friendly worktree path is taken", async () => {
    const { service, workspaceDir } = await createGitRuntime();
    const workspace = await createGitWorkspace(service, workspaceDir);
    const title = "Same name";
    const firstTask = await createGitTask(service, workspace.id, { title });
    const secondTask = await createGitTask(service, workspace.id, { title });

    await service.planTask(firstTask.id);
    await waitForRunToFinish(service, firstTask.id);
    await service.planTask(secondTask.id);
    await waitForRunToFinish(service, secondTask.id);

    const firstUpdated = service.listTasks({}).find((entry) => entry.id === firstTask.id)!;
    const secondUpdated = service.listTasks({}).find((entry) => entry.id === secondTask.id)!;

    expect(basename(firstUpdated.worktree.path ?? "")).toBe("same-name");
    expect(basename(secondUpdated.worktree.path ?? "")).toBe(`${secondTask.id}-same-name`);
  });

  it("falls back to a task-id-prefixed branch name when AI-generated branches collide", async () => {
    const { service, workspaceDir } = await createGitRuntimeWithOptions({
      taskIdentityGenerator: createTaskIdentityGeneratorStub()
    });
    const workspace = await createGitWorkspace(service, workspaceDir);
    const firstTask = await service.createTask({
      title: "   ",
      description: "Review the onboarding flow and identify the regressions.",
      workspaceId: workspace.id
    });
    const secondTask = await service.createTask({
      title: "   ",
      description: "Review the onboarding flow and patch the regressions.",
      workspaceId: workspace.id
    });

    expect(firstTask.worktree.branchName).toBe("task/fix-onboarding-flow");
    expect(secondTask.worktree.branchName).toBe(
      `task/${secondTask.id}-fix-onboarding-flow`
    );

    await service.planTask(firstTask.id);
    await waitForRunToFinish(service, firstTask.id);
    await service.planTask(secondTask.id);
    await waitForRunToFinish(service, secondTask.id);

    const firstUpdated = service.listTasks({}).find((entry) => entry.id === firstTask.id)!;
    const secondUpdated = service.listTasks({}).find((entry) => entry.id === secondTask.id)!;

    expect(basename(firstUpdated.worktree.path ?? "")).toBe("fix-onboarding-flow");
    expect(basename(secondUpdated.worktree.path ?? "")).toBe(
      `${secondTask.id}-fix-onboarding-flow`
    );
    expect(secondUpdated.worktree.branchName).toBe(
      `task/${secondTask.id}-fix-onboarding-flow`
    );
  });

  it("rejects AI branch fallback when both friendly and task-id branches already exist", async () => {
    const { service, workspaceDir } = await createGitRuntimeWithOptions({
      taskIdentityGenerator: createTaskIdentityGeneratorStub()
    });
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await service.createTask({
      title: "   ",
      description: "Review the onboarding flow and identify the regressions.",
      workspaceId: workspace.id
    });
    const fallbackBranchName = `task/${task.id}-fix-onboarding-flow`;

    await runGit(["-C", workspaceDir, "branch", task.worktree.branchName, "origin/main"]);
    await runGit(["-C", workspaceDir, "branch", fallbackBranchName, "origin/main"]);

    await expect(service.planTask(task.id)).rejects.toMatchObject({
      status: 409,
      code: "TASK_WORKTREE_BRANCH_EXISTS"
    });
  });

  it("starts a task from a fetched origin/main worktree and uses the worktree cwd", async () => {
    const { service, seedDir, workspaceDir } = await createGitRuntime();
    const workspace = await createGitWorkspace(service, workspaceDir);
    await pushMarkerUpdate(seedDir, "v2");
    const task = await createGitTask(service, workspace.id);

    await service.startTask(task.id);
    const completedRun = await waitForRunToFinish(service, task.id);
    const log = await service.getRunLog(completedRun.id);
    const joinedLog = log.map((entry) => entry.text).join("");
    const updatedTask = service.listTasks({}).find((entry) => entry.id === task.id);

    expect(completedRun.status).toBe("succeeded");
    expect(updatedTask?.worktree.path).toBeTruthy();
    expect(joinedLog).toContain(updatedTask?.worktree.path ?? "");
    expect(joinedLog).toContain("v2");
  });

  it("marks dirty worktrees as cleanup_pending and retries cleanup over HTTP", async () => {
    const { app, service, workspaceDir } = await createGitRuntime();
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id);
    await service.planTask(task.id);
    await waitForRunToFinish(service, task.id);
    const planned = service.listTasks({}).find((entry) => entry.id === task.id)!;
    const worktreePath = planned.worktree.path;

    if (!worktreePath) {
      throw new Error("Expected planned task to create a worktree path");
    }

    await appendFile(join(worktreePath, "marker.txt"), "dirty\n", "utf8");
    expect(await runGit(["-C", worktreePath, "status", "--short"])).toContain("M marker.txt");
    await expect(
      runGit(["-C", workspaceDir, "worktree", "remove", worktreePath])
    ).rejects.toBeDefined();

    const updatedTask = await service.updateTask(task.id, {
      column: "done"
    });

    expect(updatedTask.column).toBe("done");
    expect(updatedTask.worktree.status).toBe("cleanup_pending");
    expect(updatedTask.worktree.path).toBe(worktreePath);
    expect(updatedTask.worktree.cleanupReason).toBeTruthy();

    await runGit(["-C", worktreePath, "restore", "marker.txt"]);

    const response = await app.request(`/api/tasks/${task.id}/worktree/cleanup`, {
      method: "POST"
    });
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.data.task.worktree.status).toBe("removed");
    expect(payload.data.task.worktree.path).toBeUndefined();
  });

  it("rejects deleting tasks with an active worktree and surfaces branch conflicts clearly", async () => {
    const { service, workspaceDir } = await createGitRuntime();
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id, {
      title: "Branch conflict"
    });
    await service.planTask(task.id);
    await waitForRunToFinish(service, task.id);
    const planned = service.listTasks({}).find((entry) => entry.id === task.id)!;

    await expect(service.deleteTask(task.id)).rejects.toMatchObject({
      status: 409,
      code: "TASK_WORKTREE_ACTIVE"
    });

    const conflictTask = await createGitTask(service, workspace.id, {
      title: "Manual worktree owns branch"
    });
    const conflictPath = join(workspaceDir, "..", "manual-conflict");
    await mkdir(conflictPath, { recursive: true });
    await runGit([
      "-C",
      workspaceDir,
      "worktree",
      "add",
      "-b",
      conflictTask.worktree.branchName,
      conflictPath,
      "origin/main"
    ]);

    await expect(service.planTask(conflictTask.id)).rejects.toMatchObject({
      status: 409,
      code: "TASK_WORKTREE_BRANCH_IN_USE"
    });

    expect(planned.worktree.status).toBe("ready");
  });

  it("rejects invalid base refs before creating a task worktree", async () => {
    const { service, workspaceDir } = await createGitRuntime();
    const workspace = await createGitWorkspace(service, workspaceDir);

    await expect(
      createGitTask(service, workspace.id, {
        worktreeBaseRef: "origin/does-not-exist"
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_TASK_WORKTREE_BASE_REF"
    });
  });

  it("stores PR mergeability and required check counts on review tasks", async () => {
    const github = createFakeGitHubProvider();
    const { service, seedDir, workspaceDir } = await createGitRuntimeWithProvider(github.provider);
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id, {
      title: "Show PR status"
    });

    await service.startTask(task.id);
    await waitForRunToFinish(service, task.id);
    await waitForTaskColumn(service, task.id, "review");

    const taskWorktree = service.listTasks({}).find((entry) => entry.id === task.id)?.worktree.path;
    if (!taskWorktree) {
      throw new Error("Expected task to have a worktree");
    }

    const taskHeadSha = await commitAndPushTaskBranch(
      taskWorktree,
      "feature-status.txt",
      "status ready",
      "feat: add status branch change"
    );
    const baseSha = await runGit(["-C", seedDir, "rev-parse", "HEAD"]);

    const repositoryFullName = "workhorse-git-test/remote";
    const pullRequestUrl = "https://github.com/workhorse-git-test/remote/pull/91";
    github.setOpenPullRequest(repositoryFullName, task.worktree.branchName, {
      number: 91,
      url: pullRequestUrl,
      title: "Show richer PR status on review tasks",
      state: "OPEN",
      isDraft: false,
      headRef: task.worktree.branchName,
      baseRef: "main",
      headSha: taskHeadSha,
      baseSha,
      changedFiles: 2,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollupState: "PENDING",
      statusChecks: {
        total: 24,
        passed: 22,
        failed: 0,
        pending: 0,
        skipped: 2
      },
      threadCount: 3,
      reviewCount: 2,
      approvalCount: 1,
      changesRequestedCount: 1,
      files: [
        {
          path: "feature-status.txt",
          additions: 1,
          deletions: 0
        },
        {
          path: "marker.txt",
          additions: 0,
          deletions: 1
        }
      ]
    });
    github.setChecks(repositoryFullName, 91, [
      {
        bucket: "pass",
        state: "SUCCESS",
        name: "lint"
      },
      {
        bucket: "pending",
        state: "PENDING",
        name: "test"
      }
    ]);

    const poll = await service.pollGitReviewTasksForBaseUpdates();
    expect(poll.resumedTaskIds).toEqual([]);

    const updatedTask = service.listTasks({}).find((entry) => entry.id === task.id);
    expect(updatedTask?.pullRequestUrl).toBe(pullRequestUrl);
    expect(updatedTask?.pullRequest).toEqual({
      number: 91,
      title: "Show richer PR status on review tasks",
      state: "OPEN",
      isDraft: false,
      changedFiles: 2,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollupState: "PENDING",
      statusChecks: {
        total: 24,
        passed: 22,
        failed: 0,
        pending: 0,
        skipped: 2
      },
      threadCount: 3,
      reviewCount: 2,
      approvalCount: 1,
      changesRequestedCount: 1,
      checks: {
        total: 2,
        passed: 1,
        failed: 0,
        pending: 1
      },
      files: [
        {
          path: "feature-status.txt",
          additions: 1,
          deletions: 0
        },
        {
          path: "marker.txt",
          additions: 0,
          deletions: 1
        }
      ]
    });
  });

  it("preserves PR file changes when a review task is started again", async () => {
    const github = createFakeGitHubProvider();
    const { service, seedDir, workspaceDir } = await createGitRuntimeWithProvider(github.provider);
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id);

    await service.startTask(task.id);
    const initialRun = await waitForRunToFinish(service, task.id);
    expect(initialRun.status).toBe("succeeded");
    await waitForTaskColumn(service, task.id, "review");

    const taskWorktree = service.listTasks({}).find((entry) => entry.id === task.id)?.worktree.path;
    if (!taskWorktree) {
      throw new Error("Expected task to have a worktree");
    }

    const taskHeadSha = await commitAndPushTaskBranch(
      taskWorktree,
      "feature-status.txt",
      "status ready",
      "feat: add status branch change"
    );
    const baseSha = await runGit(["-C", seedDir, "rev-parse", "HEAD"]);

    const repositoryFullName = "workhorse-git-test/remote";
    github.setOpenPullRequest(repositoryFullName, task.worktree.branchName, {
      number: 91,
      url: "https://github.com/workhorse-git-test/remote/pull/91",
      title: "Preserve PR file changes after rerun",
      state: "OPEN",
      isDraft: true,
      headRef: task.worktree.branchName,
      baseRef: "main",
      headSha: taskHeadSha,
      baseSha,
      changedFiles: 2,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollupState: "SUCCESS",
      statusChecks: {
        total: 24,
        passed: 22,
        failed: 0,
        pending: 0,
        skipped: 2
      },
      threadCount: 1,
      reviewCount: 1,
      approvalCount: 1,
      files: [
        {
          path: "feature-status.txt",
          additions: 1,
          deletions: 0
        },
        {
          path: "marker.txt",
          additions: 0,
          deletions: 1
        }
      ]
    });

    const poll = await service.pollGitReviewTasksForBaseUpdates();
    expect(poll.resumedTaskIds).toEqual([]);

    await service.startTask(task.id);
    const rerun = await waitForRunToFinish(service, task.id);
    expect(rerun.status).toBe("succeeded");

    const rerunTask = service.listTasks({}).find((entry) => entry.id === task.id);
    expect(rerunTask?.pullRequest).toEqual({
      number: 91,
      title: "Preserve PR file changes after rerun",
      state: "OPEN",
      isDraft: true,
      changedFiles: 2,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollupState: "SUCCESS",
      statusChecks: {
        total: 24,
        passed: 22,
        failed: 0,
        pending: 0,
        skipped: 2
      },
      threadCount: 1,
      reviewCount: 1,
      approvalCount: 1,
      checks: undefined,
      files: [
        {
          path: "feature-status.txt",
          additions: 1,
          deletions: 0
        },
        {
          path: "marker.txt",
          additions: 0,
          deletions: 1
        }
      ]
    });
  });

  it("publishes agent reviewer output back to the pull request as a GitHub review", async () => {
    const github = createFakeGitHubProvider();
    const { service, seedDir, workspaceDir } = await createGitRuntimeWithProvider(github.provider);
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id, {
      title: "Review retry queue behavior"
    });
    const reviewerAccount = service.createAgent({
      name: "Technical Reviewer",
      description: "Reviews completed tasks for correctness and test coverage.",
      runnerConfig: {
        type: "claude",
        prompt: "Review the current changes.",
        agent: "code-reviewer"
      }
    });
    const reviewer = service.mountAgent(workspace.id, {
      agentId: reviewerAccount.id,
      role: "worker"
    });

    await service.startTask(task.id);
    const initialRun = await waitForRunToFinish(service, task.id);
    expect(initialRun.status).toBe("succeeded");

    const taskWorktree = service.listTasks({}).find((entry) => entry.id === task.id)?.worktree.path;
    if (!taskWorktree) {
      throw new Error("Expected task to have a worktree");
    }

    const taskHeadSha = await commitAndPushTaskBranch(
      taskWorktree,
      "retry-queue.txt",
      "queue edge case",
      "feat: add retry queue edge case"
    );
    const baseSha = await runGit(["-C", seedDir, "rev-parse", "HEAD"]);
    const repositoryFullName = "workhorse-git-test/remote";

    github.setOpenPullRequest(repositoryFullName, task.worktree.branchName, {
      number: 91,
      url: "https://github.com/workhorse-git-test/remote/pull/91",
      title: "Review retry queue behavior",
      state: "OPEN",
      isDraft: false,
      headRef: task.worktree.branchName,
      baseRef: "main",
      headSha: taskHeadSha,
      baseSha,
      changedFiles: 1,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "COMMENTED",
      statusCheckRollupState: "SUCCESS",
      files: [
        {
          path: "retry-queue.txt",
          additions: 1,
          deletions: 0
        }
      ]
    });

    (service as any).runners.claude = {
      type: "claude",
      async start(_context: unknown, hooks: {
        onOutput(entry: {
          kind: "agent";
          text: string;
          stream: "stdout";
          title: string;
          source: string;
        }): Promise<void>;
        onExit(result: {
          status: "succeeded";
          metadata: Record<string, string>;
        }): Promise<void>;
      }) {
        void sleep(25).then(async () => {
          await hooks.onOutput({
            kind: "agent",
            stream: "stdout",
            title: "Claude response",
            source: "Claude CLI",
            text: [
              "Cache invalidation still leaves stale entries behind when the retry queue is empty.",
              "",
              "```json",
              '{"verdict":"request_changes","summary":"Add a regression test for the empty retry queue path and clear stale cache entries before returning."}',
              "```"
            ].join("\n")
          });
          await hooks.onExit({
            status: "succeeded",
            metadata: {
              trigger: "manual_claude_review",
              reviewVerdict: "request_changes",
              reviewSummary:
                "Add a regression test for the empty retry queue path and clear stale cache entries before returning."
            }
          });
        });

        return {
          command: "claude review runner",
          async stop() {}
        };
      }
    };

    const reviewStart = await service.requestTaskReview(task.id, {
      reviewerAgentId: reviewer.id
    });
    const finishedReviewRun = await waitForRunIdToFinish(
      service,
      task.id,
      reviewStart.run.id
    );
    await waitForCondition(
      () => github.reviews.length === 1,
      "Timed out waiting for GitHub review publication"
    );
    const reviewRun = service
      .listRuns(task.id)
      .find((run) => run.id === finishedReviewRun.id)!;
    const reviewLog = await service.getRunLog(reviewStart.run.id);

    expect(reviewRun.status).toBe("succeeded");
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]).toMatchObject({
      repositoryFullName,
      pullRequest: 91,
      action: "request_changes"
    });
    expect(github.reviews[0]?.body).toContain("## Workhorse Agent Review");
    expect(github.reviews[0]?.body).toContain(
      "Cache invalidation still leaves stale entries behind when the retry queue is empty."
    );
    expect(github.reviews[0]?.body).toContain(
      "**Summary:** Add a regression test for the empty retry queue path and clear stale cache entries before returning."
    );
    expect(github.reviews[0]?.body).not.toContain("```json");
    expect(reviewRun.metadata).toMatchObject({
      reviewPublishedAction: "request_changes",
      reviewPublicationMethod: "gh_pr_review"
    });
    expect(
      reviewLog.some((entry) => entry.title === "GitHub review published")
    ).toBe(true);
  });

  it("moves merged review tasks to done and restarts review tasks when gh reports the PR is behind", async () => {
    const github = createFakeGitHubProvider();
    const { service, seedDir, workspaceDir } = await createGitRuntimeWithProvider(github.provider);
    const workspace = await createGitWorkspace(service, workspaceDir);
    const doneTask = await service.createTask({
      title: "Already done",
      workspaceId: workspace.id,
      column: "done"
    });
    const taskA = await createGitTask(service, workspace.id, {
      title: "Feature A",
      command: "node -e \"console.log('task a')\""
    });
    const taskB = await createGitTask(service, workspace.id, {
      title: "Feature B",
      command: "node -e \"console.log('task b')\""
    });

    await service.startTask(taskA.id);
    await waitForRunToFinish(service, taskA.id);
    await waitForTaskColumn(service, taskA.id, "review");
    await service.startTask(taskB.id);
    await waitForRunToFinish(service, taskB.id);
    await waitForTaskColumn(service, taskB.id, "review");

    const taskAWorktree = service.listTasks({}).find((entry) => entry.id === taskA.id)?.worktree.path;
    const taskBWorktree = service.listTasks({}).find((entry) => entry.id === taskB.id)?.worktree.path;
    if (!taskAWorktree || !taskBWorktree) {
      throw new Error("Expected both tasks to have worktrees");
    }

    await commitAndPushTaskBranch(
      taskAWorktree,
      "feature-a.txt",
      "feature-a",
      "feat: update feature a"
    );
    const taskAHeadSha = await runGit(["-C", taskAWorktree, "rev-parse", "HEAD"]);
    const taskBHeadSha = await commitAndPushTaskBranch(
      taskBWorktree,
      "feature-b.txt",
      "feature-b",
      "feat: update feature b"
    );
    const mergedBaseSha = await mergeBranchIntoMain(
      seedDir,
      taskA.worktree.branchName,
      "feat: merge feature a"
    );

    const repositoryFullName = "workhorse-git-test/remote";
    github.setMergedPullRequest(repositoryFullName, taskA.worktree.branchName, {
      number: 41,
      url: "https://github.com/workhorse-git-test/remote/pull/41",
      headRef: taskA.worktree.branchName,
      baseRef: "main",
      headSha: taskAHeadSha,
      baseSha: mergedBaseSha,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN"
    });
    github.setOpenPullRequest(repositoryFullName, taskB.worktree.branchName, {
      number: 42,
      url: "https://github.com/workhorse-git-test/remote/pull/42",
      headRef: taskB.worktree.branchName,
      baseRef: "main",
      headSha: taskBHeadSha,
      baseSha: mergedBaseSha,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND"
    });
    github.setChecks(repositoryFullName, 42, [
      {
        bucket: "pass",
        state: "SUCCESS",
        name: "ci"
      }
    ]);

    const firstPoll = await service.pollGitReviewTasksForBaseUpdates();
    expect(firstPoll.available).toBe(true);
    expect(firstPoll.resumedTaskIds).toEqual([taskB.id]);
    const firstPolledAt = service.getReviewMonitorLastPolledAt();
    expect(firstPolledAt).toBeDefined();

    const rerun = await waitForTriggeredRunToFinish(
      service,
      taskB.id,
      "gh_pr_monitor"
    );
    const updatedTaskA = service.listTasks({}).find((entry) => entry.id === taskA.id);
    const updatedTaskB = service.listTasks({}).find((entry) => entry.id === taskB.id);
    const doneTasks = service.listTasks({}).filter((entry) => entry.column === "done");

    expect(rerun.status).toBe("succeeded");
    expect(rerun.metadata?.trigger).toBe("gh_pr_monitor");
    expect(rerun.metadata?.monitorPrCiStatus).toBe("pass");
    expect(updatedTaskA?.column).toBe("done");
    expect(updatedTaskA?.worktree.status).toBe("removed");
    expect(updatedTaskB?.column).toBe("review");
    expect(doneTasks.map((task) => task.id)).toEqual([taskA.id, doneTask.id]);
    await expect(
      runGit(["-C", taskBWorktree, "merge-base", "--is-ancestor", "origin/main", "HEAD"])
    ).resolves.toBe("");

    const secondPoll = await service.pollGitReviewTasksForBaseUpdates();
    expect(secondPoll.resumedTaskIds).toEqual([]);
    expect(Date.parse(service.getReviewMonitorLastPolledAt() ?? "")).toBeGreaterThanOrEqual(
      Date.parse(firstPolledAt ?? "")
    );
  }, 15_000);

  it("restarts review tasks when required CI checks fail on the PR", async () => {
    const github = createFakeGitHubProvider();
    const { service, seedDir, workspaceDir } = await createGitRuntimeWithProvider(github.provider);
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id, {
      title: "Fix failing CI",
      command: "node -e \"console.log('rerun for ci')\""
    });

    await service.startTask(task.id);
    await waitForRunToFinish(service, task.id);

    const taskWorktree = service.listTasks({}).find((entry) => entry.id === task.id)?.worktree.path;
    if (!taskWorktree) {
      throw new Error("Expected task to have a worktree");
    }

    const taskHeadSha = await commitAndPushTaskBranch(
      taskWorktree,
      "feature-ci.txt",
      "ci needs help",
      "feat: add ci branch change"
    );
    const baseSha = await runGit(["-C", seedDir, "rev-parse", "HEAD"]);

    const repositoryFullName = "workhorse-git-test/remote";
    github.setOpenPullRequest(repositoryFullName, task.worktree.branchName, {
      number: 56,
      url: "https://github.com/workhorse-git-test/remote/pull/56",
      headRef: task.worktree.branchName,
      baseRef: "main",
      headSha: taskHeadSha,
      baseSha,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN"
    });
    github.setChecks(repositoryFullName, 56, [
      {
        bucket: "fail",
        state: "FAILURE",
        name: "ci"
      }
    ]);

    const firstPoll = await service.pollGitReviewTasksForBaseUpdates();
    expect(firstPoll.resumedTaskIds).toEqual([task.id]);

    const rerun = await waitForRunToFinish(service, task.id);
    expect(rerun.status).toBe("succeeded");
    expect(rerun.metadata?.trigger).toBe("gh_pr_monitor");
    expect(rerun.metadata?.monitorPrCiStatus).toBe("fail");

    const secondPoll = await service.pollGitReviewTasksForBaseUpdates();
    expect(secondPoll.resumedTaskIds).toEqual([]);
  });

  it("restarts review tasks when the PR receives new feedback comments", async () => {
    const github = createFakeGitHubProvider();
    const { service, seedDir, workspaceDir } = await createGitRuntimeWithProvider(github.provider);
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id, {
      title: "Address review feedback",
      command: "node -e \"console.log('rerun for feedback')\""
    });

    await service.startTask(task.id);
    const firstRun = await waitForRunToFinish(service, task.id);

    const taskWorktree = service.listTasks({}).find((entry) => entry.id === task.id)?.worktree.path;
    if (!taskWorktree) {
      throw new Error("Expected task to have a worktree");
    }

    const taskHeadSha = await commitAndPushTaskBranch(
      taskWorktree,
      "feature-feedback.txt",
      "feedback target",
      "feat: add feedback branch change"
    );
    const baseSha = await runGit(["-C", seedDir, "rev-parse", "HEAD"]);
    const feedbackAt = new Date(Date.parse(firstRun.endedAt ?? firstRun.startedAt) + 60_000).toISOString();

    const repositoryFullName = "workhorse-git-test/remote";
    github.setOpenPullRequest(repositoryFullName, task.worktree.branchName, {
      number: 64,
      url: "https://github.com/workhorse-git-test/remote/pull/64",
      headRef: task.worktree.branchName,
      baseRef: "main",
      headSha: taskHeadSha,
      baseSha,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      feedbackCount: 1,
      feedbackUpdatedAt: feedbackAt,
      feedbackItems: [
        {
          source: "comment",
          author: "reviewer",
          body: "Please rename this helper and add a quick regression test.",
          createdAt: feedbackAt,
          updatedAt: feedbackAt,
          url: "https://github.com/workhorse-git-test/remote/pull/64#issuecomment-1"
        }
      ]
    });
    github.setChecks(repositoryFullName, 64, [
      {
        bucket: "pass",
        state: "SUCCESS",
        name: "ci"
      }
    ]);

    const firstPoll = await service.pollGitReviewTasksForBaseUpdates();
    expect(firstPoll.resumedTaskIds).toEqual([task.id]);

    const rerun = await waitForRunToFinish(service, task.id);
    expect(rerun.status).toBe("succeeded");
    expect(rerun.metadata?.trigger).toBe("gh_pr_monitor");
    expect(rerun.metadata?.monitorPrFeedbackCount).toBe("1");
    expect(rerun.metadata?.monitorPrFeedbackUpdatedAt).toBe(feedbackAt);

    const secondPoll = await service.pollGitReviewTasksForBaseUpdates();
    expect(secondPoll.resumedTaskIds).toEqual([]);
  });

  it("restarts review tasks for unresolved conversations and comments on the PR once", async () => {
    const github = createFakeGitHubProvider();
    const { service, seedDir, workspaceDir } = await createGitRuntimeWithProvider(github.provider);
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id, {
      title: "Resolve unresolved conversations",
      command: "node -e \"console.log('rerun for unresolved conversations')\""
    });

    await service.startTask(task.id);
    await waitForRunToFinish(service, task.id);

    const taskWorktree = service.listTasks({}).find((entry) => entry.id === task.id)?.worktree.path;
    if (!taskWorktree) {
      throw new Error("Expected task to have a worktree");
    }

    const taskHeadSha = await commitAndPushTaskBranch(
      taskWorktree,
      "thread-target.txt",
      "needs thread fix",
      "fix: add unresolved thread target"
    );
    const baseSha = await runGit(["-C", seedDir, "rev-parse", "HEAD"]);
    const conversationUpdatedAt = new Date().toISOString();

    const repositoryFullName = "workhorse-git-test/remote";
    github.setOpenPullRequest(repositoryFullName, task.worktree.branchName, {
      number: 88,
      url: "https://github.com/workhorse-git-test/remote/pull/88",
      headRef: task.worktree.branchName,
      baseRef: "main",
      headSha: taskHeadSha,
      baseSha,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      unresolvedConversationCount: 1,
      unresolvedConversationUpdatedAt: conversationUpdatedAt,
      unresolvedConversationItems: [
        {
          id: "thread-1",
          author: "reviewer",
          body: "Please resolve this unresolved thread before merging.",
          path: "thread-target.txt",
          line: 1,
          url: "https://github.com/workhorse-git-test/remote/pull/88#discussion_r1",
          createdAt: conversationUpdatedAt,
          updatedAt: conversationUpdatedAt
        }
      ]
    });
    github.setChecks(repositoryFullName, 88, [
      {
        bucket: "pass",
        state: "SUCCESS",
        name: "ci"
      }
    ]);

    const firstPoll = await service.pollGitReviewTasksForBaseUpdates();
    expect(firstPoll.resumedTaskIds).toEqual([task.id]);

    const rerun = await waitForRunToFinish(service, task.id);
    expect(rerun.status).toBe("succeeded");
    expect(rerun.metadata?.trigger).toBe("gh_pr_monitor");
    expect(rerun.metadata?.monitorPrUnresolvedConversationCount).toBe("1");
    expect(rerun.metadata?.monitorPrUnresolvedConversationUpdatedAt).toBe(
      conversationUpdatedAt
    );
    expect(rerun.metadata?.monitorPrUnresolvedConversationSignature).toContain("thread-1");

    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]).toMatchObject({
      repositoryFullName,
      pullRequest: 88
    });
    expect(github.comments[0]?.body).toContain("Detected 1 unresolved review conversation");
    expect(github.comments[0]?.body).toContain("reply here");

    const secondPoll = await service.pollGitReviewTasksForBaseUpdates();
    expect(secondPoll.resumedTaskIds).toEqual([]);
    expect(github.comments).toHaveLength(1);
  });

  it("retries conflicting review tasks after a prior monitor rerun failed", async () => {
    const github = createFakeGitHubProvider();
    const { service, seedDir, workspaceDir } = await createGitRuntimeWithProvider(github.provider);
    const workspace = await createGitWorkspace(service, workspaceDir);
    const task = await createGitTask(service, workspace.id, {
      title: "Conflicting feature",
      command: "git rebase origin/main"
    });

    await service.startTask(task.id);
    await waitForRunToFinish(service, task.id);

    const taskWorktree = service.listTasks({}).find((entry) => entry.id === task.id)?.worktree.path;
    if (!taskWorktree) {
      throw new Error("Expected task to have a worktree");
    }

    await writeFile(join(taskWorktree, "marker.txt"), "feature change\n", "utf8");
    await runGit(["-C", taskWorktree, "add", "marker.txt"]);
    await runGit(["-C", taskWorktree, "commit", "-m", "feat: update feature marker"]);
    await runGit(["-C", taskWorktree, "push", "-u", "origin", "HEAD"]);
    const taskHeadSha = await runGit(["-C", taskWorktree, "rev-parse", "HEAD"]);

    await writeFile(join(seedDir, "marker.txt"), "main change\n", "utf8");
    await runGit(["-C", seedDir, "add", "marker.txt"]);
    await runGit(["-C", seedDir, "commit", "-m", "feat: update main marker"]);
    await runGit(["-C", seedDir, "push", "origin", "main"]);
    const baseSha = await runGit(["-C", seedDir, "rev-parse", "HEAD"]);

    const repositoryFullName = "workhorse-git-test/remote";
    github.setOpenPullRequest(repositoryFullName, task.worktree.branchName, {
      number: 77,
      url: "https://github.com/workhorse-git-test/remote/pull/77",
      headRef: task.worktree.branchName,
      baseRef: "main",
      headSha: taskHeadSha,
      baseSha,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY"
    });
    github.setChecks(repositoryFullName, 77, [
      {
        bucket: "pass",
        state: "SUCCESS",
        name: "ci"
      }
    ]);

    const firstPoll = await service.pollGitReviewTasksForBaseUpdates();
    expect(firstPoll.resumedTaskIds).toEqual([task.id]);

    const firstMonitorRun = await waitForTriggeredRunToFinish(
      service,
      task.id,
      "gh_pr_monitor"
    );
    const firstMonitorStartedAt = firstMonitorRun.startedAt;
    expect(firstMonitorRun.status).toBe("failed");
    expect(firstMonitorRun.metadata?.trigger).toBe("gh_pr_monitor");

    const taskAfterFailure = service.listTasks({}).find((entry) => entry.id === task.id);
    expect(taskAfterFailure?.column).toBe("review");

    const secondPoll = await service.pollGitReviewTasksForBaseUpdates();
    expect(secondPoll.resumedTaskIds).toEqual([task.id]);

    const secondMonitorRun = await waitForTriggeredRunToFinish(
      service,
      task.id,
      "gh_pr_monitor",
      firstMonitorStartedAt
    );
    expect(secondMonitorRun.startedAt).not.toBe(firstMonitorStartedAt);
    expect(secondMonitorRun.status).toBe("failed");
    expect(secondMonitorRun.metadata?.trigger).toBe("gh_pr_monitor");
  }, 15_000);
});
