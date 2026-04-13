import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { HealthCodexQuotaData, Run, Task } from "@workhorse/contracts";

import { createApp } from "./app.js";
import { createRunLogEntry } from "./lib/run-log.js";
import { StateStore } from "./persistence/state-store.js";
import type { CodexAppServer } from "./runners/codex-app-server-manager.js";
import { CodexAcpRunner } from "./runners/codex-acp-runner.js";
import type { RunnerAdapter, RunnerControl, RunnerLifecycleHooks, RunnerStartContext } from "./runners/types.js";
import { ShellRunner } from "./runners/shell-runner.js";
import type { TaskIdentityGenerator } from "./services/openrouter-task-naming-service.js";
import { BoardService } from "./services/board-service.js";
import type { WorkspaceRootPicker } from "./services/workspace-root-picker.js";
import { EventBus } from "./ws/event-bus.js";

class MockClaudeRunner implements RunnerAdapter {
  public readonly type = "claude" as const;
  public async start(
    _context: RunnerStartContext,
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

class HoldingRunner implements RunnerAdapter {
  public constructor(public readonly type: "claude" | "codex" | "shell") {}

  public async start(
    _context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl> {
    let stopped = false;

    return {
      command: `${this.type} (holding mock)`,
      async stop() {
        if (stopped) {
          return;
        }

        stopped = true;
        await hooks.onExit({
          status: "canceled",
          exitCode: 0
        });
      }
    };
  }
}

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

function createTaskIdentityGeneratorStub(
  result = {
    title: "修复引导流程",
    worktreeName: "fix-onboarding-flow"
  }
): TaskIdentityGenerator {
  return {
    async generate() {
      return result;
    }
  };
}

async function createRuntime(options?: {
  reviewMonitorIntervalMs?: number;
  codexAppServer?: CodexAppServer;
  taskIdentityGenerator?: TaskIdentityGenerator;
  workspaceRootPicker?: WorkspaceRootPicker;
  runners?: Record<string, RunnerAdapter>;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "workhorse-test-"));
  const workspaceDir = join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  const codexServer = options?.codexAppServer ?? createCodexAppServerStub();
  const service = new BoardService(new StateStore(dataDir), new EventBus(), {
    codexAppServer: codexServer,
    taskIdentityGenerator: options?.taskIdentityGenerator,
    workspaceRootPicker: options?.workspaceRootPicker,
    runners:
      options?.runners ??
      {
        claude: new MockClaudeRunner(),
        shell: new ShellRunner(),
        codex: new CodexAcpRunner(codexServer)
      }
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

async function createClaudeTask(
  service: BoardService,
  workspaceId: string,
  column: "backlog" | "todo" | "review" = "backlog"
) {
  return service.createTask({
    title: "Run claude task",
    workspaceId,
    column,
    runnerType: "claude",
    runnerConfig: {
      type: "claude",
      prompt: "Review the current changes and summarize concrete issues.",
      agent: "code-reviewer"
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

async function waitForTaskColumn(
  service: BoardService,
  taskId: string,
  column: string,
  timeoutMs = 5_000
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const task = service.listTasks({}).find((entry) => entry.id === taskId);
    if (task?.column === column) {
      return task;
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for task ${taskId} to reach ${column}`);
}

async function setTaskDependencies(
  service: BoardService,
  taskId: string,
  dependencies: string[]
) {
  const store = (service as any).store as StateStore;
  store.setTasks(
    service.snapshot().tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            dependencies,
            updatedAt: new Date().toISOString()
          }
        : task
    )
  );
  await store.save();
}

async function createReviewSubtask(
  service: BoardService,
  input: {
    workspaceId: string;
    teamId: string;
    parentTaskId: string;
    title: string;
    runnerType?: Task["runnerType"];
    runnerConfig?: Task["runnerConfig"];
    lastRunStatus?: Run["status"];
  }
) {
  const store = (service as any).store as StateStore;
  const now = new Date().toISOString();
  const taskId = `subtask-${Math.random().toString(36).slice(2, 10)}`;
  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  const task: Task = {
    id: taskId,
    title: input.title,
    description: "",
    workspaceId: input.workspaceId,
    column: "review",
    order: 1_024,
    runnerType: input.runnerType ?? "shell",
    runnerConfig:
      input.runnerConfig ??
      {
        type: "shell",
        command: "true"
      },
    dependencies: [],
    worktree: {
      baseRef: "main",
      branchName: `team/${input.teamId}/${taskId}`,
      status: "ready"
    },
    lastRunId: runId,
    lastRunStatus: input.lastRunStatus ?? "succeeded",
    rejected: false,
    teamId: input.teamId,
    parentTaskId: input.parentTaskId,
    teamAgentId: "agent-worker",
    createdAt: now,
    updatedAt: now
  };
  const run: Run = {
    id: runId,
    taskId,
    status: input.lastRunStatus ?? "succeeded",
    runnerType: task.runnerType,
    command: task.runnerType === "shell" ? "true" : "codex mock",
    startedAt: now,
    endedAt: now
  };

  await store.updateState((state) => {
    state.tasks.push(task);
    state.runs.push(run);
    return null;
  });

  return task;
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
    expect(openApiPayload.paths["/api/workspaces/pick-root"]).toBeDefined();
  });

  it("returns the selected workspace root path over HTTP", async () => {
    const { app } = await createRuntime({
      workspaceRootPicker: {
        async pickRootPath() {
          return "/tmp/workspaces/frontend";
        }
      }
    });

    const response = await app.request("/api/workspaces/pick-root", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      ok: true,
      data: {
        rootPath: "/tmp/workspaces/frontend"
      }
    });
  });

  it("posts a human team message over HTTP and returns the created message", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const team = service.createTeam({
      name: "Delivery Team",
      workspaceId: workspace.id,
      agents: [
        {
          id: "agent-coordinator",
          agentName: "Coordinator",
          role: "coordinator",
          runnerConfig: {
            type: "codex",
            prompt: "Coordinate the work."
          }
        },
        {
          id: "agent-worker",
          agentName: "Worker",
          role: "worker",
          runnerConfig: {
            type: "codex",
            prompt: "Implement the assigned task."
          }
        }
      ]
    });
    const task = await service.createTask({
      title: "Coordinate rollout",
      workspaceId: workspace.id,
      teamId: team.id,
      column: "todo",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "echo should-be-overridden"
      }
    });

    const response = await app.request(`/api/teams/${team.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        parentTaskId: task.id,
        content: "Please wait for human approval before creating subtasks."
      })
    });

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.data.item).toMatchObject({
      teamId: team.id,
      parentTaskId: task.id,
      taskId: task.id,
      agentName: "User",
      senderType: "human",
      messageType: "feedback",
      content: "Please wait for human approval before creating subtasks."
    });

    const listResponse = await app.request(
      `/api/teams/${team.id}/messages?parentTaskId=${encodeURIComponent(task.id)}`
    );
    expect(listResponse.status).toBe(200);
    const listPayload = await listResponse.json();
    expect(listPayload.data.items).toHaveLength(1);
    expect(listPayload.data.items[0]?.senderType).toBe("human");
  });

  it("rejects posting a human team message to a non-parent task thread", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const team = service.createTeam({
      name: "Delivery Team",
      workspaceId: workspace.id,
      agents: [
        {
          id: "agent-coordinator",
          agentName: "Coordinator",
          role: "coordinator",
          runnerConfig: {
            type: "codex",
            prompt: "Coordinate the work."
          }
        }
      ]
    });
    const unrelatedTask = await service.createTask({
      title: "Standalone task",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "echo standalone"
      }
    });

    const response = await app.request(`/api/teams/${team.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        parentTaskId: unrelatedTask.id,
        content: "Need more context here."
      })
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("INVALID_PARENT_TASK");
  });

  it("returns 404 when posting a human team message for a missing team", async () => {
    const { app } = await createRuntime();

    const response = await app.request("/api/teams/team-missing/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        parentTaskId: "task-parent",
        content: "Need a human checkpoint."
      })
    });

    expect(response.status).toBe(404);
    const payload = await response.json();
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("TEAM_NOT_FOUND");
  });

  it("approves a succeeded review subtask over HTTP", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const team = service.createTeam({
      name: "Delivery Team",
      workspaceId: workspace.id,
      autoApproveSubtasks: false,
      agents: [
        {
          id: "agent-coordinator",
          agentName: "Coordinator",
          role: "coordinator",
          runnerConfig: {
            type: "codex",
            prompt: "Coordinate the work."
          }
        },
        {
          id: "agent-worker",
          agentName: "Worker",
          role: "worker",
          runnerConfig: {
            type: "codex",
            prompt: "Implement the assigned task."
          }
        }
      ]
    });
    const parentTask = await service.createTask({
      title: "Coordinate rollout",
      workspaceId: workspace.id,
      teamId: team.id,
      column: "running",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "echo should-be-overridden"
      }
    });
    const subtask = await createReviewSubtask(service, {
      workspaceId: workspace.id,
      teamId: team.id,
      parentTaskId: parentTask.id,
      title: "Implement UI",
      lastRunStatus: "succeeded"
    });

    const response = await app.request(`/api/tasks/${subtask.id}/approve`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.task).toMatchObject({
      id: subtask.id,
      column: "done",
      rejected: false
    });
    expect(service.getTask(parentTask.id).column).toBe("review");
  });

  it("approves a review subtask when lastRunStatus falls back to the latest run", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const team = service.createTeam({
      name: "Delivery Team",
      workspaceId: workspace.id,
      autoApproveSubtasks: false,
      agents: [
        {
          id: "agent-coordinator",
          agentName: "Coordinator",
          role: "coordinator",
          runnerConfig: {
            type: "codex",
            prompt: "Coordinate the work."
          }
        },
        {
          id: "agent-worker",
          agentName: "Worker",
          role: "worker",
          runnerConfig: {
            type: "codex",
            prompt: "Implement the assigned task."
          }
        }
      ]
    });
    const parentTask = await service.createTask({
      title: "Coordinate rollout",
      workspaceId: workspace.id,
      teamId: team.id,
      column: "running",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "echo should-be-overridden"
      }
    });
    const subtask = await createReviewSubtask(service, {
      workspaceId: workspace.id,
      teamId: team.id,
      parentTaskId: parentTask.id,
      title: "Implement UI",
      lastRunStatus: "succeeded"
    });
    const store = (service as any).store as StateStore;
    await store.updateState((state) => {
      const entry = state.tasks.find((task) => task.id === subtask.id);
      if (!entry) {
        return null;
      }
      entry.lastRunStatus = undefined;
      return null;
    });

    const response = await app.request(`/api/tasks/${subtask.id}/approve`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.task).toMatchObject({
      id: subtask.id,
      column: "done",
      rejected: false
    });
  });

  it("rejects a review subtask over HTTP and records the reason", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const team = service.createTeam({
      name: "Delivery Team",
      workspaceId: workspace.id,
      autoApproveSubtasks: false,
      agents: [
        {
          id: "agent-coordinator",
          agentName: "Coordinator",
          role: "coordinator",
          runnerConfig: {
            type: "codex",
            prompt: "Coordinate the work."
          }
        }
      ]
    });
    const parentTask = await service.createTask({
      title: "Coordinate rollout",
      workspaceId: workspace.id,
      teamId: team.id,
      column: "running",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "echo should-be-overridden"
      }
    });
    const subtask = await createReviewSubtask(service, {
      workspaceId: workspace.id,
      teamId: team.id,
      parentTaskId: parentTask.id,
      title: "Implement API",
      lastRunStatus: "failed"
    });

    const response = await app.request(`/api/tasks/${subtask.id}/reject`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        reason: "Out of scope"
      })
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.task).toMatchObject({
      id: subtask.id,
      column: "done",
      rejected: true
    });
    expect(
      service
        .listTeamMessages(team.id, parentTask.id)
        .some((message) => message.content.includes("Out of scope"))
    ).toBe(true);
  });

  it("retries a review subtask over HTTP", async () => {
    const { app, service, workspaceDir } = await createRuntime({
      runners: {
        claude: new MockClaudeRunner(),
        codex: new HoldingRunner("codex"),
        shell: new HoldingRunner("shell")
      }
    });
    const workspace = await createWorkspace(service, workspaceDir);
    const team = service.createTeam({
      name: "Delivery Team",
      workspaceId: workspace.id,
      autoApproveSubtasks: false,
      agents: [
        {
          id: "agent-coordinator",
          agentName: "Coordinator",
          role: "coordinator",
          runnerConfig: {
            type: "codex",
            prompt: "Coordinate the work."
          }
        }
      ]
    });
    const parentTask = await service.createTask({
      title: "Coordinate rollout",
      workspaceId: workspace.id,
      teamId: team.id,
      column: "todo",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "echo should-be-overridden"
      }
    });
    const subtask = await createReviewSubtask(service, {
      workspaceId: workspace.id,
      teamId: team.id,
      parentTaskId: parentTask.id,
      title: "Retry task",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "echo retry"
      },
      lastRunStatus: "failed"
    });

    const response = await app.request(`/api/tasks/${subtask.id}/retry`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(["todo", "running"]).toContain(payload.data.task.column);
    expect(service.getTask(subtask.id).rejected).toBe(false);
    expect(service.getTask(subtask.id).lastRunStatus).not.toBe("failed");
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

  it("reports default global settings", async () => {
    const { app } = await createRuntime();

    const response = await app.request("/api/settings");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.data.settings).toEqual({
      language: "中文",
      openRouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        token: "",
        model: ""
      }
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

  it("generates a task title and worktree name from description when title is blank", async () => {
    const { service, workspaceDir } = await createRuntime({
      taskIdentityGenerator: createTaskIdentityGeneratorStub({
        title: "整理登录错误",
        worktreeName: "triage-login-errors"
      })
    });
    const workspace = await createWorkspace(service, workspaceDir);

    const task = await service.createTask({
      title: "   ",
      description: "梳理登录报错，确认复现路径并补上基础保护。",
      workspaceId: workspace.id,
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "true"
      }
    });

    expect(task.title).toBe("整理登录错误");
    expect(task.worktree.branchName).toContain("triage-login-errors");
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

  it("runs a claude task through the registered runner and persists the log", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createClaudeTask(service, workspace.id);

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
            text: "Review complete.\n",
            stream: "stdout",
            title: "Claude response",
            source: "Claude CLI"
          });
          await hooks.onExit({
            status: "succeeded",
            metadata: {
              claudeSessionId: "session-1"
            }
          });
        });

        return {
          command: "claude -p --verbose --output-format stream-json --agent code-reviewer",
          metadata: {
            claudeAgent: "code-reviewer"
          },
          async stop() {}
        };
      }
    };

    const startResult = await service.startTask(task.id);
    expect(startResult.run.status).toBe("running");

    const completedRun = await waitForRunToFinish(service, task.id);
    const updatedTask = service.listTasks({}).find((entry) => entry.id === task.id);
    const log = await service.getRunLog(completedRun.id);

    expect(completedRun.status).toBe("succeeded");
    expect(completedRun.metadata?.claudeSessionId).toBe("session-1");
    expect(updatedTask?.column).toBe("review");
    expect(log.some((entry) => entry.text.includes("Review complete."))).toBe(true);
  });

  it("starts a manual Claude review run over HTTP for tasks in review", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    await mkdir(join(workspaceDir, ".git"), { recursive: true });
    (service as any).gitWorktrees = {
      async resolveBaseRef() {
        return "origin/main";
      },
      async ensureTaskWorktree(
        _workspace: unknown,
        reviewTask: { worktree: { path?: string; status: string } }
      ) {
        return {
          ...reviewTask.worktree,
          path: reviewTask.worktree.path ?? workspaceDir,
          status: "ready"
        };
      },
      async getGitHubRepositoryFullName() {
        return null;
      }
    };
    (service as any).githubPullRequests = {
      async isAvailable() {
        return false;
      }
    };
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createCodexTask(service, workspace.id, "review");

    (service as any).runners.claude = {
      type: "claude",
      async start(_context: unknown, hooks: {
        onExit(result: {
          status: "succeeded";
          metadata: Record<string, string>;
        }): Promise<void>;
      }) {
        void sleep(25).then(() =>
          hooks.onExit({
            status: "succeeded",
            metadata: {
              reviewVerdict: "comment",
              reviewSummary: "Looks good overall, but add one more test around retries."
            }
          })
        );

        return {
          command: "claude -p --verbose --output-format stream-json --agent code-reviewer",
          async stop() {}
        };
      }
    };

    const response = await app.request(`/api/tasks/${task.id}/review-request`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.run.runnerType).toBe("claude");
    expect(payload.data.run.metadata).toMatchObject({
      trigger: "manual_claude_review",
      reviewAgent: "claude_code"
    });

    const completedRun = await waitForRunToFinish(service, task.id);
    expect(completedRun.metadata).toMatchObject({
      reviewVerdict: "comment",
      reviewSummary: "Looks good overall, but add one more test around retries."
    });
  });

  it("preserves the previous codex continuation run after a Claude review run", async () => {
    const { service, workspaceDir } = await createRuntime();
    await mkdir(join(workspaceDir, ".git"), { recursive: true });
    (service as any).gitWorktrees = {
      async resolveBaseRef() {
        return "origin/main";
      },
      async ensureTaskWorktree(
        _workspace: unknown,
        reviewTask: { worktree: { path?: string; status: string } }
      ) {
        return {
          ...reviewTask.worktree,
          path: reviewTask.worktree.path ?? workspaceDir,
          status: "ready"
        };
      },
      async getGitHubRepositoryFullName() {
        return null;
      }
    };
    (service as any).githubPullRequests = {
      async isAvailable() {
        return false;
      }
    };
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createCodexTask(service, workspace.id, "review");
    const previousRunId = "run-author-1";
    const now = new Date().toISOString();
    const store = (service as any).store as StateStore;

    store.setTasks(
      service.snapshot().tasks.map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              lastRunId: previousRunId,
              continuationRunId: previousRunId
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
          threadId: "thread-author-1",
          turnId: "turn-author-1"
        }
      }
    ]);
    await store.save();

    (service as any).runners.claude = {
      type: "claude",
      async start(_context: unknown, hooks: {
        onExit(result: {
          status: "succeeded";
          metadata: Record<string, string>;
        }): Promise<void>;
      }) {
        void sleep(25).then(() =>
          hooks.onExit({
            status: "succeeded",
            metadata: {
              reviewVerdict: "comment",
              reviewSummary: "Consider adding a regression test for the empty retry queue path."
            }
          })
        );

        return {
          command: "claude review runner",
          async stop() {}
        };
      }
    };

    const reviewResult = await service.requestTaskReview(task.id);
    let completedReviewRun: Run | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      completedReviewRun = service
        .listRuns(task.id)
        .find((entry) => entry.id === reviewResult.run.id && Boolean(entry.endedAt));
      if (completedReviewRun) {
        break;
      }
      await sleep(25);
    }
    if (!completedReviewRun) {
      throw new Error("Expected Claude review run to finish");
    }
    const taskAfterReview = service.listTasks({}).find((entry) => entry.id === task.id);

    expect(reviewResult.run.runnerType).toBe("claude");
    expect(completedReviewRun.metadata?.reviewVerdict).toBe("comment");
    expect(taskAfterReview?.lastRunId).toBe(reviewResult.run.id);
    expect(taskAfterReview?.continuationRunId).toBe(previousRunId);

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
              threadId: "thread-author-1",
              turnId: "turn-author-2"
            }
          })
        );

        return {
          command: "codex test runner",
          metadata: {
            threadId: "thread-author-1",
            turnId: "turn-author-2"
          },
          async stop() {}
        };
      }
    };

    const resumed = await service.sendTaskInput(task.id, {
      text: "Please address the reviewer feedback."
    });

    expect(resumed.run.id).toBe(previousRunId);
    expect((capturedContext?.previousRun as Run | undefined)?.metadata?.threadId).toBe(
      "thread-author-1"
    );
    expect(service.listTasks({}).find((entry) => entry.id === task.id)?.lastRunId).toBe(
      previousRunId
    );
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

  it("updates workspace prompt templates and resolves plan prompts with workspace context", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    const updated = await service.updateWorkspace(workspace.id, {
      promptTemplates: {
        plan: "Plan {{taskTitle}} inside {{workingDirectory}} on {{baseRef}}.",
        coding: "Prompt: {{taskPrompt}}",
        review: "Review {{taskTitle}}",
        reviewFollowUp: "Rework {{taskTitle}}"
      }
    });
    const task = await createCodexTask(service, workspace.id);

    expect(updated.promptTemplates).toEqual({
      plan: "Plan {{taskTitle}} inside {{workingDirectory}} on {{baseRef}}.",
      coding: "Prompt: {{taskPrompt}}",
      review: "Review {{taskTitle}}",
      reviewFollowUp: "Rework {{taskTitle}}"
    });
    expect((service as any).buildPlanPrompt(task, updated)).toBe(
      `Plan ${task.title} inside ${workspaceDir} on ${task.worktree.baseRef}.`
    );
  });

  it("clears workspace prompt templates when the update payload sends an empty object", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    await service.updateWorkspace(workspace.id, {
      promptTemplates: {
        coding: "Prompt: {{taskPrompt}}"
      }
    });

    const updated = await service.updateWorkspace(workspace.id, {
      promptTemplates: {}
    });

    expect(updated.promptTemplates).toBeUndefined();
    expect(service.listWorkspaces().find((entry) => entry.id === workspace.id)?.promptTemplates).toBeUndefined();
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

  it("rejects starting a task whose dependencies are not done", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const dependency = await createShellTask(service, workspace.id);
    const task = await createShellTask(
      service,
      workspace.id,
      "node -e \"setInterval(() => {}, 50)\""
    );

    await setTaskDependencies(service, task.id, [dependency.id]);

    await expect(service.startTask(task.id)).rejects.toMatchObject({
      status: 409,
      code: "DEPENDENCIES_NOT_MET",
      message: "Task dependencies are not satisfied"
    });
  });

  it("moves todo tasks with unmet dependencies into blocked", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const dependency = await createShellTask(service, workspace.id);
    const task = await createShellTask(service, workspace.id);

    await setTaskDependencies(service, task.id, [dependency.id]);
    await service.updateTask(task.id, {
      column: "todo"
    });

    const updatedTask = service.listTasks({}).find((entry) => entry.id === task.id);
    expect(updatedTask?.column).toBe("blocked");
  });

  it("unblocks and starts dependent todo tasks when a dependency moves to done", async () => {
    const { service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const dependency = await createShellTask(service, workspace.id);
    const task = await createShellTask(
      service,
      workspace.id,
      "node -e \"setInterval(() => {}, 50)\""
    );

    await setTaskDependencies(service, task.id, [dependency.id]);
    await service.updateTask(task.id, {
      column: "todo"
    });
    expect(service.listTasks({}).find((entry) => entry.id === task.id)?.column).toBe(
      "blocked"
    );

    await service.updateTask(dependency.id, {
      column: "done"
    });
    await waitForTaskColumn(service, task.id, "running");

    await service.stopTask(task.id);
    await waitForRunToFinish(service, task.id);
  });

  it("limits scheduler launches to one active codex task by default", async () => {
    const codexRunner = new HoldingRunner("codex");
    const { service, workspaceDir } = await createRuntime({
      runners: {
        claude: new MockClaudeRunner(),
        shell: new ShellRunner(),
        codex: codexRunner
      }
    });
    const workspace = await createWorkspace(service, workspaceDir);
    const first = await createCodexTask(service, workspace.id);
    const second = await createCodexTask(service, workspace.id);

    await service.updateTask(first.id, {
      column: "todo"
    });
    await waitForTaskColumn(service, first.id, "running");

    await service.updateTask(second.id, {
      column: "todo"
    });

    expect(service.listTasks({}).find((entry) => entry.id === second.id)?.column).toBe(
      "todo"
    );

    await service.stopTask(first.id);
    await waitForRunToFinish(service, first.id);
  });

  it("starts newly unblocked tasks in priority order", async () => {
    const shellRunner = new HoldingRunner("shell");
    const { service, workspaceDir } = await createRuntime({
      runners: {
        claude: new MockClaudeRunner(),
        shell: shellRunner,
        codex: new HoldingRunner("codex")
      }
    });
    const workspace = await createWorkspace(service, workspaceDir);
    const dependency = await createShellTask(service, workspace.id);
    const highPriority = await createShellTask(service, workspace.id);
    const lowPriority = await createShellTask(service, workspace.id);

    await setTaskDependencies(service, highPriority.id, [dependency.id]);
    await setTaskDependencies(service, lowPriority.id, [dependency.id]);

    await service.updateTask(highPriority.id, {
      column: "todo"
    });
    await service.updateTask(lowPriority.id, {
      column: "todo"
    });

    await service.updateTask(dependency.id, {
      column: "done"
    });
    await waitForTaskColumn(service, highPriority.id, "running");
    await waitForTaskColumn(service, lowPriority.id, "running");

    const runningTasks = service.listTasks({}).filter((task) => task.column === "running");
    expect(runningTasks.map((task) => task.id)).toEqual([
      highPriority.id,
      lowPriority.id
    ]);

    await service.stopTask(highPriority.id);
    await service.stopTask(lowPriority.id);
    await waitForRunToFinish(service, highPriority.id);
    await waitForRunToFinish(service, lowPriority.id);
  });

  it("starts tasks from the API without a request body", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const task = await createShellTask(
      service,
      workspace.id,
      "node -e \"setInterval(() => {}, 50)\""
    );

    const response = await app.request(`/api/tasks/${task.id}/start`, {
      method: "POST"
    });

    expect(response.status).toBe(200);

    await service.stopTask(task.id);
    await waitForRunToFinish(service, task.id);
  });

  it("plans backlog tasks by starting a plan run", async () => {
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
    expect(payload.data.task.column).toBe("backlog");
    expect(payload.data.run).toBeDefined();
    expect(payload.data.run.metadata?.trigger).toBe("plan_generation");

    await waitForRunToFinish(service, task.id);
    const updatedTask = service.listTasks({}).find((entry) => entry.id === task.id);
    expect(updatedTask?.column).toBe("todo");
    expect(updatedTask?.plan).toContain("Mock plan");
  });

  it("places planned tasks at the top of todo after plan run completes", async () => {
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

    await service.planTask(backlogTask.id);
    await waitForRunToFinish(service, backlogTask.id);
    const todoTasks = service.listTasks({}).filter((task) => task.column === "todo");
    const updatedBacklog = todoTasks.find((task) => task.id === backlogTask.id);

    expect(updatedBacklog).toBeDefined();
    expect(updatedBacklog!.order).toBeLessThan(todoOne.order);
    expect(todoTasks.map((task) => task.id)).toEqual([
      backlogTask.id,
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

  it("places started tasks at the requested running order", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    const runningOne = await service.createTask({
      title: "Running one",
      workspaceId: workspace.id,
      column: "running",
      order: 1_024,
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
      order: 3_072,
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

    const response = await app.request(`/api/tasks/${task.id}/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        order: 2_048
      })
    });

    expect(response.status).toBe(200);
    const runningTasks = service.listTasks({}).filter((entry) => entry.column === "running");
    expect(runningTasks.map((entry) => entry.id)).toEqual([
      runningOne.id,
      task.id,
      runningTwo.id
    ]);

    await service.stopTask(task.id);
    await waitForRunToFinish(service, task.id);
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

describe("dependency management API", () => {
  it("sets and reads task dependencies", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    const taskA = await createShellTask(service, workspace.id);
    const taskB = await createShellTask(service, workspace.id);

    // Set A depends on B
    const putRes = await app.request(`/api/tasks/${taskA.id}/dependencies`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependencies: [taskB.id] })
    });
    expect(putRes.status).toBe(200);
    const putData = (await putRes.json()) as { ok: boolean; data: { task: { dependencies: string[] } } };
    expect(putData.ok).toBe(true);
    expect(putData.data.task.dependencies).toEqual([taskB.id]);

    // Read dependencies
    const getRes = await app.request(`/api/tasks/${taskA.id}/dependencies`);
    expect(getRes.status).toBe(200);
    const getData = (await getRes.json()) as { ok: boolean; data: { task: { dependencies: string[] } } };
    expect(getData.data.task.dependencies).toEqual([taskB.id]);
  });

  it("rejects setting dependencies on a nonexistent task", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const taskA = await createShellTask(service, workspace.id);

    const res = await app.request(`/api/tasks/${taskA.id}/dependencies`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependencies: ["nonexistent-id"] })
    });
    expect(res.status).toBe(404);
    const data = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(data.error.code).toBe("DEPENDENCY_NOT_FOUND");
  });

  it("rejects cross-workspace dependencies", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const ws1 = await createWorkspace(service, workspaceDir, "Workspace 1");
    const ws2 = await createWorkspace(service, workspaceDir, "Workspace 2");
    const taskA = await createShellTask(service, ws1.id);
    const taskB = await createShellTask(service, ws2.id);

    const res = await app.request(`/api/tasks/${taskA.id}/dependencies`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependencies: [taskB.id] })
    });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(data.error.code).toBe("DEPENDENCY_CROSS_WORKSPACE");
  });

  it("rejects self-dependencies", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const taskA = await createShellTask(service, workspace.id);

    const res = await app.request(`/api/tasks/${taskA.id}/dependencies`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependencies: [taskA.id] })
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(data.error.code).toBe("SELF_DEPENDENCY");
  });

  it("rejects circular dependencies (A → B → A)", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const taskA = await createShellTask(service, workspace.id);
    const taskB = await createShellTask(service, workspace.id);

    // A → B (OK)
    await app.request(`/api/tasks/${taskA.id}/dependencies`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependencies: [taskB.id] })
    });

    // B → A (creates cycle)
    const res = await app.request(`/api/tasks/${taskB.id}/dependencies`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependencies: [taskA.id] })
    });
    expect(res.status).toBe(422);
    const data = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(data.error.code).toBe("DEPENDENCY_CYCLE");
  });

  it("blocks start when dependency is not done (409 DEPENDENCIES_NOT_MET)", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const taskA = await createShellTask(service, workspace.id);
    const taskB = await createShellTask(service, workspace.id);

    // A depends on B; B is not done — start from backlog to avoid scheduler interference
    await service.setTaskDependencies(taskA.id, [taskB.id]);

    const res = await app.request(`/api/tasks/${taskA.id}/start`, {
      method: "POST"
    });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(data.error.code).toBe("DEPENDENCIES_NOT_MET");
  });

  it("allows start when all dependencies are done", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);
    const taskA = await createShellTask(service, workspace.id, "true");
    const taskB = await createShellTask(service, workspace.id, "true");

    // A depends on B; move B to done — keep A in backlog so scheduler doesn't auto-start it
    await service.setTaskDependencies(taskA.id, [taskB.id]);
    await service.updateTask(taskB.id, { column: "done" });

    const res = await app.request(`/api/tasks/${taskA.id}/start`, {
      method: "POST"
    });
    expect(res.status).toBe(200);
  });
});

describe("scheduler API", () => {
  it("returns scheduler status counts", async () => {
    const { app, service, workspaceDir } = await createRuntime();
    const workspace = await createWorkspace(service, workspaceDir);

    await createShellTask(service, workspace.id);  // backlog
    await service.createTask({
      title: "Todo task",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "shell",
      runnerConfig: { type: "shell", command: "true" }
    });
    await service.createTask({
      title: "Blocked task",
      workspaceId: workspace.id,
      column: "blocked",
      runnerType: "shell",
      runnerConfig: { type: "shell", command: "true" }
    });

    const res = await app.request("/api/scheduler/status");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; data: { running: number; queued: number; blocked: number } };
    expect(data.ok).toBe(true);
    expect(data.data.running).toBe(0);
    expect(data.data.queued).toBe(1);
    expect(data.data.blocked).toBe(1);
  });

  it("returns scheduler evaluate result with no pending tasks", async () => {
    const { app } = await createRuntime();
    const res = await app.request("/api/scheduler/evaluate", { method: "POST" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; data: { started: string[]; blocked: string[] } };
    expect(data.ok).toBe(true);
    expect(data.data.started).toEqual([]);
    expect(data.data.blocked).toEqual([]);
  });
});
