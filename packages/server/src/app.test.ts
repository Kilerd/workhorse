import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { Run } from "@workhorse/contracts";

import { createApp } from "./app.js";
import { StateStore } from "./persistence/state-store.js";
import { BoardService } from "./services/board-service.js";
import { EventBus } from "./ws/event-bus.js";

async function createRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), "workhorse-test-"));
  const workspaceDir = join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  const service = new BoardService(new StateStore(dataDir), new EventBus());
  await service.initialize();

  return {
    app: createApp(service),
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

    const listResponse = await app.request("/api/tasks");
    expect(listResponse.status).toBe(200);
    const listPayload = await listResponse.json();
    expect(listPayload.data.items).toHaveLength(1);

    const openApiResponse = await app.request("/openapi.json");
    expect(openApiResponse.status).toBe(200);
    const openApiPayload = await openApiResponse.json();
    expect(openApiPayload.openapi).toBe("3.0.3");
    expect(openApiPayload.paths["/api/tasks"]).toBeDefined();
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
    expect(log).toContain("hello from shell");
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

  it("marks orphaned runs as canceled during initialization", async () => {
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
});
