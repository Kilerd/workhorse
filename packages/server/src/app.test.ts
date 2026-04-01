import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { Run } from "@workhorse/contracts";

import { createApp } from "./app.js";
import { StateStore } from "./persistence/state-store.js";
import { BoardService } from "./services/board-service.js";
import { EventBus } from "./ws/event-bus.js";

async function createRuntime(options?: { reviewMonitorIntervalMs?: number }) {
  const dataDir = await mkdtemp(join(tmpdir(), "workhorse-test-"));
  const workspaceDir = join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  const service = new BoardService(new StateStore(dataDir), new EventBus());
  await service.initialize();

  return {
    app: createApp(service, options),
    dataDir,
    workspaceDir,
    service
  };
}

async function createWorkspace(
  service: BoardService,
  workspaceDir: string,
  name = "Sample"
) {
  return service.createWorkspace({
    name,
    rootPath: workspaceDir
  });
}

async function createShellTask(
  service: BoardService,
  workspaceId: string,
  command = "node -e \"console.log('hello from shell')\""
) {
  return service.createTask({
    title: "Run shell command",
    workspaceId,
    runnerType: "shell",
    runnerConfig: {
      type: "shell",
      command
    }
  });
}

async function createCodexTask(
  service: BoardService,
  workspaceId: string,
  column: "backlog" | "todo" | "review" = "backlog"
) {
  return service.createTask({
    title: "Run codex task",
    workspaceId,
    column,
    runnerType: "codex",
    runnerConfig: {
      type: "codex",
      prompt: "Continue the task"
    }
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

describe("workhorse runtime", () => {
  it("creates a workspace and task over HTTP", async () => {
    const { app, workspaceDir } = await createRuntime();

    const workspaceResponse = await app.request("/api/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "Sample",
        rootPath: workspaceDir
      })
    });

    expect(workspaceResponse.status).toBe(201);
    const workspacePayload = await workspaceResponse.json();
    expect(workspacePayload.ok).toBe(true);

    const taskResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Run shell command",
        workspaceId: workspacePayload.data.workspace.id,
        runnerType: "shell",
        runnerConfig: {
          type: "shell",
          command: "node -e \"console.log('hello from shell')\""
        }
      })
    });

    expect(taskResponse.status).toBe(201);
    const taskPayload = await taskResponse.json();
    expect(taskPayload.ok).toBe(true);
    expect(taskPayload.data.task.column).toBe("backlog");

    const listResponse = await app.request("/api/tasks");
    expect(listResponse.status).toBe(200);
    const listPayload = await listResponse.json();
    expect(listPayload.data.items).toHaveLength(1);

    const openApiResponse = await app.request("/openapi.json");
    expect(openApiResponse.status).toBe(200);
    const openApiPayload = await openApiResponse.json();
    expect(openApiPayload.openapi).toBe("3.0.3");
    expect(openApiPayload.paths["/api/tasks"]).toBeDefined();
    expect(openApiPayload.paths["/api/tasks/{taskId}/plan"]).toBeDefined();
  });

  it("reports review monitor timing in health responses", async () => {
    const { app } = await createRuntime({ reviewMonitorIntervalMs: 15_000 });

    const response = await app.request("/api/health");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.data.reviewMonitor).toEqual({
      intervalMs: 15_000,
      lastPolledAt: undefined
    });
  });

  it("runs a shell task to completion and persists the log", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createShellTask(service, workspace.id);

    const startResult = await service.startTask(task.id);
    expect(startResult.run.status).toBe("running");

    const completedRun = await waitForRunToFinish(service, task.id);
    const updatedTask = service.listTasks({}).find((entry) => entry.id === task.id);

    expect(completedRun.status).toBe("succeeded");
    expect(updatedTask?.column).toBe("review");

    const log = await service.getRunLog(completedRun.id);
    expect(log.some((entry) => entry.text.includes("hello from shell"))).toBe(true);
    expect(log.some((entry) => entry.kind === "text")).toBe(true);
  });

  it("stops an active shell task and marks the run canceled", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createShellTask(
      service,
      workspace.id,
      "node -e \"setInterval(() => console.log('tick'), 50)\""
    );

    await service.startTask(task.id);
    await sleep(150);
    await service.stopTask(task.id);

    const completedRun = await waitForRunToFinish(service, task.id);
    const updatedTask = service.listTasks({}).find((entry) => entry.id === task.id);

    expect(completedRun.status).toBe("canceled");
    expect(updatedTask?.column).toBe("review");
  });

  it("marks orphaned shell runs as canceled during initialization", async () => {
    const { dataDir, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createShellTask(service, workspace.id);
    const runId = "run-orphaned";

    const snapshot = service.snapshot();
    const taskEntry = snapshot.tasks.find((entry) => entry.id === task.id);
    expect(taskEntry).toBeDefined();

    const store = new StateStore(dataDir);
    await store.load();
    store.setTasks(
      snapshot.tasks.map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              column: "running",
              lastRunId: runId
            }
          : entry
      )
    );
    store.setRuns([
      {
        id: runId,
        taskId: task.id,
        status: "running",
        runnerType: "shell",
        command: "node -e \"console.log('orphan')\"",
        startedAt: new Date().toISOString(),
        logFile: store.createLogPath(runId)
      }
    ]);
    await store.save();

    const reloadedService = new BoardService(store, new EventBus());
    await reloadedService.initialize();

    const recoveredRun = reloadedService.listRuns(task.id)[0];
    const recoveredTask = reloadedService
      .listTasks({})
      .find((entry) => entry.id === task.id);

    if (!recoveredRun) {
      throw new Error("Expected orphaned run to be recovered");
    }
    expect(recoveredRun.status).toBe("canceled");
    expect(recoveredRun.endedAt).toBeTruthy();
    expect(recoveredTask?.column).toBe("review");
  });

  it("marks orphaned codex runs as interrupted during initialization", async () => {
    const { dataDir, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createCodexTask(service, workspace.id, "review");
    const runId = "run-orphaned-codex";

    const snapshot = service.snapshot();

    const store = new StateStore(dataDir);
    await store.load();
    store.setTasks(
      snapshot.tasks.map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              column: "running",
              lastRunId: runId
            }
          : entry
      )
    );
    store.setRuns([
      {
        id: runId,
        taskId: task.id,
        status: "running",
        runnerType: "codex",
        command: "codex app-server --listen ws://127.0.0.1:9123",
        startedAt: new Date().toISOString(),
        logFile: store.createLogPath(runId),
        metadata: {
          threadId: "thread-1",
          turnId: "turn-1"
        }
      }
    ]);
    await store.save();

    const reloadedService = new BoardService(store, new EventBus());
    await reloadedService.initialize();

    const recoveredRun = reloadedService.listRuns(task.id)[0];
    const recoveredTask = reloadedService
      .listTasks({})
      .find((entry) => entry.id === task.id);

    if (!recoveredRun) {
      throw new Error("Expected orphaned codex run to be recovered");
    }
    expect(recoveredRun.status).toBe("interrupted");
    expect(recoveredRun.endedAt).toBeTruthy();
    expect(recoveredTask?.column).toBe("review");
  });

  it("stores the pull request url on tasks that move into review", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createCodexTask(service, workspace.id);
    const prUrl = "https://github.com/acme/widgets/pull/42";

    (service as any).runners.codex = {
      type: "codex",
      async start(_context: unknown, hooks: { onExit(result: {
        status: "succeeded";
        metadata: Record<string, string>;
      }): Promise<void> }) {
        void sleep(25).then(() =>
          hooks.onExit({
            status: "succeeded",
            metadata: {
              prUrl
            }
          })
        );

        return {
          command: "codex test runner",
          async stop() {}
        };
      }
    };

    await service.startTask(task.id);

    const completedRun = await waitForRunToFinish(service, task.id);
    const updatedTask = service.listTasks({}).find((entry) => entry.id === task.id);

    expect(completedRun.metadata?.prUrl).toBe(prUrl);
    expect(updatedTask?.column).toBe("review");
    expect(updatedTask?.pullRequestUrl).toBe(prUrl);
  });

  it("rejects workspace paths that are not directories", async () => {
    const { service, dataDir } = await createRuntime();
    const filePath = join(dataDir, "not-a-directory.txt");
    await writeFile(filePath, "content", "utf8");

    await expect(
      service.createWorkspace({
        name: "Invalid",
        rootPath: filePath
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_WORKSPACE",
      message: "Workspace path must be a directory"
    });
  });

  it("rejects blank workspace updates", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    await expect(
      service.updateWorkspace(workspace.id, {
        name: "   "
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_WORKSPACE",
      message: "Workspace name is required"
    });
  });

  it("rejects blank task title updates", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createShellTask(service, workspace.id);

    await expect(
      service.updateTask(task.id, {
        title: "   "
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_TASK",
      message: "Task title is required"
    });
  });

  it("allows review tasks to be started again but rejects done tasks", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const reviewTask = await service.createTask({
      title: "Review task",
      workspaceId: workspace.id,
      column: "review",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });

    const startResult = await service.startTask(reviewTask.id);
    expect(startResult.run.status).toBe("running");
    const completedRun = await waitForRunToFinish(service, reviewTask.id);
    expect(completedRun.status).toBe("succeeded");

    const doneTask = await service.createTask({
      title: "Done task",
      workspaceId: workspace.id,
      column: "done",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });

    await expect(service.startTask(doneTask.id)).rejects.toMatchObject({
      status: 409,
      code: "TASK_NOT_STARTABLE",
      message: "Tasks in done cannot be started"
    });
  });

  it("plans backlog tasks and moves them into todo", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await service.createTask({
      title: "Plan me",
      description: "Need a rollout.",
      workspaceId: workspace.id,
      runnerType: "codex",
      runnerConfig: {
        type: "codex",
        prompt: "Create a plan"
      }
    });

    const response = await app.request(`/api/tasks/${task.id}/plan`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.data.task.column).toBe("todo");
    expect(payload.data.plan).toContain("# Plan");
    expect(payload.data.task.description).toContain("Need a rollout.");
  });

  it("places planned tasks at the top of todo", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    const todoOne = await service.createTask({
      title: "Todo one",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "codex",
      runnerConfig: {
        type: "codex",
        prompt: "Continue the task"
      }
    });
    const todoTwo = await service.createTask({
      title: "Todo two",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "codex",
      runnerConfig: {
        type: "codex",
        prompt: "Continue the task"
      }
    });
    const backlogTask = await service.createTask({
      title: "Plan me next",
      workspaceId: workspace.id,
      runnerType: "codex",
      runnerConfig: {
        type: "codex",
        prompt: "Continue the task"
      }
    });

    const result = await service.planTask(backlogTask.id);
    const todoTasks = service.listTasks({}).filter((task) => task.column === "todo");

    expect(result.task.order).toBeLessThan(todoOne.order);
    expect(todoTasks.map((task) => task.id)).toEqual([
      result.task.id,
      todoOne.id,
      todoTwo.id
    ]);
  });

  it("places started tasks at the top of running and completed tasks at the top of review", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    const runningOne = await service.createTask({
      title: "Running one",
      workspaceId: workspace.id,
      column: "running",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    const runningTwo = await service.createTask({
      title: "Running two",
      workspaceId: workspace.id,
      column: "running",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    const reviewOne = await service.createTask({
      title: "Review one",
      workspaceId: workspace.id,
      column: "review",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    const reviewTwo = await service.createTask({
      title: "Review two",
      workspaceId: workspace.id,
      column: "review",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    const task = await createShellTask(
      service,
      workspace.id,
      "node -e \"setInterval(() => {}, 50)\""
    );

    await service.startTask(task.id);

    const runningTasks = service.listTasks({}).filter((entry) => entry.column === "running");
    expect(runningTasks.map((entry) => entry.id)).toEqual([
      task.id,
      runningOne.id,
      runningTwo.id
    ]);

    await service.stopTask(task.id);
    const completedRun = await waitForRunToFinish(service, task.id);
    expect(completedRun.status).toBe("canceled");

    const reviewTasks = service.listTasks({}).filter((entry) => entry.column === "review");
    expect(reviewTasks.map((entry) => entry.id)).toEqual([
      task.id,
      reviewOne.id,
      reviewTwo.id
    ]);
  });

  it("moves tasks to the end of the destination column by default", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    const doneOne = await service.createTask({
      title: "Done one",
      workspaceId: workspace.id,
      column: "done",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    const doneTwo = await service.createTask({
      title: "Done two",
      workspaceId: workspace.id,
      column: "done",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    const reviewTask = await service.createTask({
      title: "Review me",
      workspaceId: workspace.id,
      column: "review",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });

    const movedTask = await service.updateTask(reviewTask.id, {
      column: "done"
    });
    const doneTasks = service
      .listTasks({})
      .filter((task) => task.column === "done");

    expect(movedTask.order).toBeGreaterThan(doneTwo.order);
    expect(doneTasks.map((task) => task.id)).toEqual([
      doneOne.id,
      doneTwo.id,
      movedTask.id
    ]);
  });

  it("lists tasks using board column order", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    await service.createTask({
      title: "Backlog task",
      workspaceId: workspace.id,
      column: "backlog",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    await service.createTask({
      title: "Archived task",
      workspaceId: workspace.id,
      column: "archived",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    await service.createTask({
      title: "Todo task",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    await service.createTask({
      title: "Done task",
      workspaceId: workspace.id,
      column: "done",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    await service.createTask({
      title: "Review task",
      workspaceId: workspace.id,
      column: "review",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });
    await service.createTask({
      title: "Running task",
      workspaceId: workspace.id,
      column: "running",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });

    expect(service.listTasks({}).map((task) => task.column)).toEqual([
      "backlog",
      "todo",
      "running",
      "review",
      "done",
      "archived"
    ]);
  });
});
