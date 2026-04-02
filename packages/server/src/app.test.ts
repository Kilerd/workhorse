import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { HealthCodexQuotaData, Run } from "@workhorse/contracts";

import { createApp } from "./app.js";
import { createRunLogEntry } from "./lib/run-log.js";
import { StateStore } from "./persistence/state-store.js";
import type { CodexAppServer } from "./runners/codex-app-server-manager.js";
import { BoardService } from "./services/board-service.js";
import { EventBus } from "./ws/event-bus.js";

function createCodexAppServerStub(
  quota: HealthCodexQuotaData | null = null,
  overrides: {
    archiveThread?(threadId: string): Promise<void> | void;
  } = {}
): CodexAppServer {
  return {
    async initialize() {},
    async createConnection() {
      throw new Error("Codex app-server connections are not available in tests");
    },
    async readAccountRateLimits() {
      return quota;
    },
    async archiveThread(threadId: string) {
      await overrides.archiveThread?.(threadId);
    }
  };
}

async function createRuntime(options?: {
  reviewMonitorIntervalMs?: number;
  codexAppServer?: CodexAppServer;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "workhorse-test-"));
  const workspaceDir = join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  const service = new BoardService(new StateStore(dataDir), new EventBus(), {
    codexAppServer: options?.codexAppServer ?? createCodexAppServerStub()
  });
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
    expect(workspacePayload.data.workspace.codexSettings).toEqual({
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write"
    });

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
    expect(payload.data.codexQuota).toBeNull();
  });

  it("reports codex quota in health responses", async () => {
    const codexQuota: HealthCodexQuotaData = {
      limitId: "codex",
      planType: "plus",
      primary: {
        usedPercent: 60,
        remainingPercent: 40,
        windowDurationMins: 300,
        resetsAt: "2026-04-01T10:45:37.000Z"
      },
      secondary: {
        usedPercent: 17,
        remainingPercent: 83,
        windowDurationMins: 10_080,
        resetsAt: "2026-04-08T05:45:37.000Z"
      }
    };
    const { app } = await createRuntime({
      codexAppServer: createCodexAppServerStub(codexQuota)
    });

    const response = await app.request("/api/health");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.data.codexQuota).toEqual(codexQuota);
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

  it("serializes run output persistence and publication in emission order", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createCodexTask(service, workspace.id, "review");
    const store = (service as any).store as StateStore;
    const events = (service as any).events as EventBus;
    const publishedOutput: string[] = [];
    const appendLogEntry = store.appendLogEntry.bind(store);
    const publish = events.publish.bind(events);

    store.appendLogEntry = async (runId, entry) => {
      if (entry.text === "first message") {
        await sleep(50);
      }

      await appendLogEntry(runId, entry);
    };
    events.publish = (event) => {
      if (event.type === "run.output") {
        publishedOutput.push(event.entry.text);
      }

      publish(event);
    };

    (service as any).runners.codex = {
      type: "codex",
      async start(_context: unknown, hooks: {
        onOutput(entry: {
          kind: "agent";
          text: string;
          stream: "stdout";
          title: string;
          metadata: Record<string, string>;
        }): Promise<void>;
        onExit(result: {
          status: "succeeded";
        }): Promise<void>;
      }) {
        const first = hooks.onOutput({
          kind: "agent",
          text: "first message",
          stream: "stdout",
          title: "Agent output",
          metadata: {
            groupId: "agent:turn-1:item-1"
          }
        });
        const second = hooks.onOutput({
          kind: "agent",
          text: "second message",
          stream: "stdout",
          title: "Agent output",
          metadata: {
            groupId: "agent:turn-1:item-2"
          }
        });

        void Promise.all([first, second]).then(() =>
          hooks.onExit({
            status: "succeeded"
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
    const log = await service.getRunLog(completedRun.id);

    expect(log.map((entry) => entry.text)).toEqual(["first message", "second message"]);
    expect(publishedOutput).toEqual(["first message", "second message"]);
  });

  it("sends live input into an active codex run and persists it to the log", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createCodexTask(service, workspace.id, "review");
    const sendInputCalls: string[] = [];

    (service as any).runners.codex = {
      type: "codex",
      async start(_context: unknown, hooks: {
        onExit(result: {
          status: "canceled";
        }): Promise<void>;
      }) {
        return {
          command: "codex test runner",
          metadata: {
            threadId: "thread-1",
            turnId: "turn-1"
          },
          async sendInput(text: string) {
            sendInputCalls.push(text);
            return {
              metadata: {
                threadId: "thread-1",
                turnId: "turn-2"
              }
            };
          },
          async stop() {
            await hooks.onExit({
              status: "canceled"
            });
          }
        };
      }
    };

    const started = await service.startTask(task.id);
    const result = await service.sendTaskInput(task.id, {
      text: "Please fix the failing test too."
    });

    expect(result.run.id).toBe(started.run.id);
    expect(sendInputCalls).toEqual(["Please fix the failing test too."]);

    const log = await service.getRunLog(started.run.id);
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "user",
          title: "User input",
          text: "Please fix the failing test too."
        })
      ])
    );

    await service.stopTask(task.id);
    const completedRun = await waitForRunToFinish(service, task.id);
    expect(completedRun.metadata?.turnId).toBe("turn-2");
  });

  it("reuses the previous run log when sending follow-up input from review", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createCodexTask(service, workspace.id, "review");
    const previousRunId = "run-previous";
    const now = new Date().toISOString();
    const store = (service as any).store as StateStore;

    store.setTasks(
      service.snapshot().tasks.map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              lastRunId: previousRunId
            }
          : entry
      )
    );
    store.setRuns([
      {
        id: previousRunId,
        taskId: task.id,
        status: "succeeded",
        runnerType: "codex",
        command: "codex test runner",
        startedAt: now,
        endedAt: now,
        logFile: store.createLogPath(previousRunId),
        metadata: {
          threadId: "thread-previous",
          turnId: "turn-previous"
        }
      }
    ]);
    await store.appendLogEntry(
      previousRunId,
      createRunLogEntry(previousRunId, {
        kind: "agent",
        stream: "stdout",
        title: "Agent output",
        text: "Existing output.\n"
      })
    );
    await store.save();

    let capturedContext: Record<string, unknown> | undefined;
    (service as any).runners.codex = {
      type: "codex",
      async start(context: Record<string, unknown>, hooks: {
        onExit(result: {
          status: "succeeded";
          metadata: Record<string, string>;
        }): Promise<void>;
      }) {
        capturedContext = context;
        void sleep(25).then(() =>
          hooks.onExit({
            status: "succeeded",
            metadata: {
              threadId: "thread-previous",
              turnId: "turn-next"
            }
          })
        );

        return {
          command: "codex test runner",
          metadata: {
            threadId: "thread-previous",
            turnId: "turn-next"
          },
          async stop() {}
        };
      }
    };

    const result = await service.sendTaskInput(task.id, {
      text: "Address the review feedback."
    });
    let completedRun: Run | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      completedRun = service
        .listRuns(task.id)
        .find((entry) => entry.id === result.run.id && Boolean(entry.endedAt));
      if (completedRun) {
        break;
      }
      await sleep(25);
    }
    const log = await service.getRunLog(result.run.id);

    expect(result.run.id).toBe(previousRunId);
    expect((capturedContext?.previousRun as Run | undefined)?.metadata?.threadId).toBe(
      "thread-previous"
    );
    expect(capturedContext?.inputText).toBe("Address the review feedback.");
    expect(service.listRuns(task.id).map((entry) => entry.id)).toEqual([previousRunId]);
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent",
          text: "Existing output.\n"
        }),
        expect.objectContaining({
          kind: "user",
          text: "Address the review feedback."
        })
      ])
    );
    expect(completedRun?.id).toBe(result.run.id);
  });

  it("reuses the previous codex run when restarting a review task", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createCodexTask(service, workspace.id, "review");
    const previousRunId = "run-previous";
    const now = new Date().toISOString();
    const store = (service as any).store as StateStore;

    store.setTasks(
      service.snapshot().tasks.map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              lastRunId: previousRunId
            }
          : entry
      )
    );
    store.setRuns([
      {
        id: previousRunId,
        taskId: task.id,
        status: "succeeded",
        runnerType: "codex",
        command: "codex test runner",
        startedAt: now,
        endedAt: now,
        logFile: store.createLogPath(previousRunId),
        metadata: {
          threadId: "thread-previous",
          turnId: "turn-previous"
        }
      }
    ]);
    await store.appendLogEntry(
      previousRunId,
      createRunLogEntry(previousRunId, {
        kind: "agent",
        stream: "stdout",
        title: "Agent output",
        text: "Existing output.\n"
      })
    );
    await store.save();

    let capturedContext: Record<string, unknown> | undefined;
    (service as any).runners.codex = {
      type: "codex",
      async start(context: Record<string, unknown>, hooks: {
        onExit(result: {
          status: "succeeded";
          metadata: Record<string, string>;
        }): Promise<void>;
      }) {
        capturedContext = context;
        void sleep(25).then(() =>
          hooks.onExit({
            status: "succeeded",
            metadata: {
              threadId: "thread-previous",
              turnId: "turn-next"
            }
          })
        );

        return {
          command: "codex test runner",
          metadata: {
            threadId: "thread-previous",
            turnId: "turn-next"
          },
          async stop() {}
        };
      }
    };

    const result = await service.startTask(task.id);
    const completedRun = await waitForRunToFinish(service, task.id);
    const log = await service.getRunLog(result.run.id);

    expect(result.run.id).toBe(previousRunId);
    expect((capturedContext?.previousRun as Run | undefined)?.metadata?.threadId).toBe(
      "thread-previous"
    );
    expect(service.listRuns(task.id).map((entry) => entry.id)).toEqual([previousRunId]);
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent",
          text: "Existing output.\n"
        })
      ])
    );
    expect(completedRun.id).toBe(previousRunId);
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

  it("updates workspace codex settings", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    const updated = await service.updateWorkspace(workspace.id, {
      codexSettings: {
        approvalPolicy: "untrusted",
        sandboxMode: "read-only"
      }
    });

    expect(updated.codexSettings).toEqual({
      approvalPolicy: "untrusted",
      sandboxMode: "read-only"
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

  it("archives the codex thread when a review task moves to done", async () => {
    const archivedThreadIds: string[] = [];
    const { service, workspaceDir } = await createRuntime({
      codexAppServer: createCodexAppServerStub(null, {
        archiveThread(threadId: string) {
          archivedThreadIds.push(threadId);
        }
      })
    });
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createCodexTask(service, workspace.id, "review");
    const previousRunId = "run-previous";
    const now = new Date().toISOString();
    const store = (service as any).store as StateStore;

    store.setTasks(
      service.snapshot().tasks.map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              lastRunId: previousRunId
            }
          : entry
      )
    );
    store.setRuns([
      {
        id: previousRunId,
        taskId: task.id,
        status: "succeeded",
        runnerType: "codex",
        command: "codex test runner",
        startedAt: now,
        endedAt: now,
        logFile: store.createLogPath(previousRunId),
        metadata: {
          threadId: "thread-previous",
          turnId: "turn-previous"
        }
      }
    ]);
    await store.save();

    await service.updateTask(task.id, {
      column: "done"
    });

    expect(archivedThreadIds).toEqual(["thread-previous"]);
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
