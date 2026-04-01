import { execFile } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { Run } from "@workhorse/contracts";

import { createApp } from "./app.js";
import { StateStore } from "./persistence/state-store.js";
import { BoardService } from "./services/board-service.js";
import { EventBus } from "./ws/event-bus.js";

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
  const dataDir = await mkdtemp(join(tmpdir(), "workhorse-git-test-"));
  const gitRepo = await createGitRepository(dataDir);
  const service = new BoardService(new StateStore(dataDir), new EventBus());
  await service.initialize();

  return {
    app: createApp(service),
    dataDir,
    service,
    ...gitRepo
  };
}

async function createGitWorkspace(service: BoardService, workspaceDir: string, name = "Repo") {
  return service.createWorkspace({
    name,
    rootPath: workspaceDir
  });
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
    runnerType: "shell",
    runnerConfig: {
      type: "shell",
      command:
        overrides.command ??
        "node -e \"const fs=require('fs'); console.log(process.cwd()); console.log(fs.readFileSync('marker.txt','utf8').trim())\""
    },
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
          runnerType: "shell",
          runnerConfig: {
            type: "shell",
            command: "true"
          },
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

    expect(snapshot.schemaVersion).toBe(2);
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

    expect(result.task.column).toBe("todo");
    expect(result.task.worktree.status).toBe("ready");
    expect(result.task.worktree.path).toBeTruthy();
    expect(await readFile(join(result.task.worktree.path!, "marker.txt"), "utf8")).toContain("v1");
    expect(await runGit(["-C", result.task.worktree.path!, "rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      result.task.worktree.branchName
    );
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
    const planned = await service.planTask(task.id);
    const worktreePath = planned.task.worktree.path;

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
    const planned = await service.planTask(task.id);

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

    expect(planned.task.worktree.status).toBe("ready");
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
});
