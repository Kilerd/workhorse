import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type {
  CreateTeamBody,
  RunnerConfig,
  Run,
  ServerEvent,
  Task
} from "@workhorse/contracts";

import { BoardService } from "./board-service.js";
import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";
import type { CodexAppServer } from "../runners/codex-app-server-manager.js";
import type { RunnerAdapter, RunnerControl, RunnerLifecycleHooks, RunnerStartContext } from "../runners/types.js";

class RecordingEventBus extends EventBus {
  public readonly published: ServerEvent[] = [];
  private hasFailed = false;

  public constructor(private readonly failOnType?: ServerEvent["type"]) {
    super();
  }

  public override publish(event: ServerEvent): void {
    if (!this.hasFailed && this.failOnType === event.type) {
      this.hasFailed = true;
      throw new Error(`Injected event bus failure for ${event.type}`);
    }
    this.published.push(event);
    super.publish(event);
  }
}

class IdleRunner implements RunnerAdapter {
  public constructor(public readonly type: "claude" | "shell") {}

  public async start(
    _context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl> {
    void sleep(0).then(() => hooks.onExit({ status: "succeeded", exitCode: 0 }));
    return {
      command: `${this.type} mock`,
      async stop() {}
    };
  }
}

interface CodexScript {
  outputText?: string;
  exit: {
    status: Run["status"];
    exitCode?: number;
    metadata?: Record<string, string>;
  };
}

class ScriptedCodexRunner implements RunnerAdapter {
  public readonly type = "codex" as const;

  public readonly contexts: RunnerStartContext[] = [];

  public constructor(private readonly scripts: CodexScript[]) {}

  public async start(
    context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl> {
    const script = this.scripts.shift();
    if (!script) {
      throw new Error("No codex script configured");
    }

    this.contexts.push(context);
    void sleep(0).then(async () => {
      if (script.outputText) {
        await hooks.onOutput({
          kind: "agent",
          stream: "stdout",
          title: "Agent output",
          text: script.outputText
        });
      }
      await hooks.onExit(script.exit);
    });

    return {
      command: "codex mock",
      metadata: script.exit.metadata,
      async stop() {}
    };
  }
}

function createCodexAppServerStub(): CodexAppServer {
  return {
    async initialize() {},
    async createConnection() {
      throw new Error("Codex app-server connections are not available in tests");
    },
    async readAccountRateLimits() {
      return null;
    },
    async archiveThread() {}
  };
}

async function waitFor<T>(
  getter: () => T | undefined,
  timeoutMs = 5_000
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = getter();
    if (value !== undefined) {
      return value;
    }
    await sleep(25);
  }

  throw new Error("Timed out waiting for condition");
}

async function waitForRunToFinish(service: BoardService, taskId: string): Promise<Run> {
  return waitFor(() => service.listRuns(taskId).find((entry) => entry.endedAt != null));
}

async function waitForTask(
  service: BoardService,
  taskId: string,
  predicate: (task: Task) => boolean
): Promise<Task> {
  return waitFor(() => service.listTasks({}).find((entry) => entry.id === taskId && predicate(entry)));
}

async function createRuntime(
  codexRunner: ScriptedCodexRunner,
  options: { events?: RecordingEventBus } = {}
) {
  const dataDir = await mkdtemp(join(tmpdir(), "workhorse-team-runtime-"));
  const workspaceDir = join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  const events = options.events ?? new RecordingEventBus();
  const service = new BoardService(new StateStore(dataDir), events, {
    codexAppServer: createCodexAppServerStub(),
    runners: {
      codex: codexRunner,
      claude: new IdleRunner("claude"),
      shell: new IdleRunner("shell")
    }
  });
  await service.initialize();

  const workspace = await service.createWorkspace({
    name: "Agent Team",
    rootPath: workspaceDir
  });

  const settings = service.getSettings();
  await service.updateSettings({
    language: settings.language,
    openRouter: settings.openRouter,
    scheduler: { maxConcurrent: 0 }
  });

  return { events, service, workspace };
}

async function attachTaskToTeam(service: BoardService, taskId: string, teamId: string) {
  const store = (service as unknown as { store: StateStore }).store;
  await store.updateTask(taskId, (task) => ({
    ...task,
    teamId,
    updatedAt: new Date().toISOString()
  }));
}

function makeTeam(workspaceId: string): CreateTeamBody {
  const coordinatorRunner: RunnerConfig = {
    type: "codex",
    prompt: "Break the parent task into executable subtasks."
  };
  const workerRunner: RunnerConfig = {
    type: "codex",
    prompt: "Implement the assigned subtask and report concrete results."
  };

  return {
    name: "Delivery Team",
    description: "Coordinates agent work",
    workspaceId,
    prStrategy: "independent",
    agents: [
      {
        id: "agent-coordinator",
        agentName: "Coordinator",
        role: "coordinator",
        runnerConfig: coordinatorRunner
      },
      {
        id: "agent-worker",
        agentName: "Worker",
        role: "worker",
        runnerConfig: workerRunner
      }
    ]
  };
}

describe("team execution integration", () => {
  it("creates subtasks, persists team messages, and keeps the parent task running", async () => {
    const coordinatorOutput = JSON.stringify([
      {
        title: "Implement data model",
        description: "Add parentTaskId and teamAgentId wiring.",
        assignedAgent: "Worker",
        dependencies: []
      },
      {
        title: "Wire coordinator callbacks",
        description: "Hook run completion into subtask creation.",
        assignedAgent: "Worker",
        dependencies: ["Implement data model"]
      }
    ]);
    const codexRunner = new ScriptedCodexRunner([
      {
        outputText: coordinatorOutput,
        exit: { status: "succeeded", exitCode: 0 }
      }
    ]);
    const { events, service, workspace } = await createRuntime(codexRunner);
    const team = service.createTeam(makeTeam(workspace.id));
    const parentTask = await service.createTask({
      title: "Deliver team execution",
      description: "Coordinate the next implementation batch.",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "codex",
      runnerConfig: {
        type: "codex",
        prompt: "Plan and delegate the implementation."
      }
    });
    await attachTaskToTeam(service, parentTask.id, team.id);

    const started = await service.startTask(parentTask.id);
    const run = await waitForRunToFinish(service, parentTask.id);
    const finalParent = await waitForTask(service, parentTask.id, (task) => task.column === "running");
    const subtasks = service
      .listTasks({})
      .filter((task) => task.parentTaskId === parentTask.id)
      .sort((left, right) => left.order - right.order);
    const messages = service.listTeamMessages(team.id, parentTask.id);

    expect(started.run.metadata).toMatchObject({
      trigger: "team_coordinator",
      teamId: team.id,
      teamAgentId: "agent-coordinator",
      parentTaskId: parentTask.id
    });
    const coordinatorContext = codexRunner.contexts[0];
    expect(coordinatorContext?.task.runnerConfig).toMatchObject({
      type: "codex",
      prompt: expect.stringContaining("--- SYSTEM CONTEXT ---")
    });
    expect((coordinatorContext?.task.runnerConfig as { prompt: string }).prompt).toContain(
      "Plan and delegate the implementation."
    );
    expect(run.status).toBe("succeeded");
    expect(finalParent.column).toBe("running");
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0]).toMatchObject({
      teamId: team.id,
      parentTaskId: parentTask.id,
      teamAgentId: "agent-worker",
      runnerType: "codex"
    });
    expect(subtasks[1]?.dependencies).toEqual([subtasks[0]!.id]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      teamId: team.id,
      parentTaskId: parentTask.id,
      taskId: parentTask.id,
      agentName: "Coordinator",
      senderType: "agent",
      messageType: "context"
    });
    expect(events.published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "team.agent.message",
          teamId: team.id,
          parentTaskId: parentTask.id
        }),
        expect.objectContaining({
          type: "team.task.created",
          teamId: team.id,
          parentTaskId: parentTask.id
        })
      ])
    );
  });

  it("injects team context and historical messages into subtask prompts", async () => {
    const coordinatorOutput = JSON.stringify([
      {
        title: "Implement runtime hook",
        description: "Wire run completion to child task creation.",
        assignedAgent: "Worker",
        dependencies: []
      }
    ]);
    const codexRunner = new ScriptedCodexRunner([
      {
        outputText: coordinatorOutput,
        exit: { status: "succeeded", exitCode: 0 }
      },
      {
        outputText: "Subtask complete.",
        exit: { status: "succeeded", exitCode: 0 }
      }
    ]);
    const { service, workspace } = await createRuntime(codexRunner);
    const team = service.createTeam(makeTeam(workspace.id));
    const parentTask = await service.createTask({
      title: "Finish coordinator integration",
      description: "Delegate the remaining coordinator flow work.",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "codex",
      runnerConfig: {
        type: "codex",
        prompt: "Split the work and assign it."
      }
    });
    await attachTaskToTeam(service, parentTask.id, team.id);

    await service.startTask(parentTask.id);
    await waitForRunToFinish(service, parentTask.id);
    const subtask = await waitFor(() =>
      service.listTasks({}).find((task) => task.parentTaskId === parentTask.id)
    );

    const childRun = await waitForRunToFinish(service, subtask.id);

    expect(childRun.metadata).toMatchObject({
      trigger: "team_subtask",
      teamId: team.id,
      teamAgentId: "agent-worker",
      parentTaskId: parentTask.id
    });
    const subtaskContext = codexRunner.contexts[1];
    expect(subtaskContext?.task.runnerConfig).toMatchObject({
      type: "codex",
      prompt: expect.stringContaining("Historical team messages:")
    });
    const subtaskPrompt = (subtaskContext?.task.runnerConfig as { prompt: string }).prompt;
    expect(subtaskPrompt).toContain("Team: Delivery Team");
    expect(subtaskPrompt).toContain("Parent task: Finish coordinator integration");
    expect(subtaskPrompt).toContain("Coordinator created subtasks:");
    expect(subtaskPrompt).toContain("Title: Implement runtime hook");
    expect(subtaskPrompt).toContain("Implement the assigned subtask and report concrete results.");
  });

  it("leaves the parent task in review when coordinator output is invalid", async () => {
    const codexRunner = new ScriptedCodexRunner([
      {
        outputText: "not valid json",
        exit: { status: "succeeded", exitCode: 0 }
      }
    ]);
    const { service, workspace } = await createRuntime(codexRunner);
    const team = service.createTeam(makeTeam(workspace.id));
    const parentTask = await service.createTask({
      title: "Attempt invalid delegation",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "codex",
      runnerConfig: {
        type: "codex",
        prompt: "Emit something malformed."
      }
    });
    await attachTaskToTeam(service, parentTask.id, team.id);

    const started = await service.startTask(parentTask.id);
    await waitForRunToFinish(service, parentTask.id);
    const reviewTask = await waitForTask(service, parentTask.id, (task) => task.column === "review");
    const log = await service.getRunLog(started.run.id);

    expect(reviewTask.column).toBe("review");
    expect(service.listTasks({}).filter((task) => task.parentTaskId === parentTask.id)).toHaveLength(0);
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          title: "Coordinator parse error"
        })
      ])
    );
  });

  it("returns the parent task to review if post-commit event publication fails", async () => {
    const coordinatorOutput = JSON.stringify([
      {
        title: "Implement data model",
        description: "Add parentTaskId and teamAgentId wiring.",
        assignedAgent: "Worker",
        dependencies: []
      }
    ]);
    const codexRunner = new ScriptedCodexRunner([
      {
        outputText: coordinatorOutput,
        exit: { status: "succeeded", exitCode: 0 }
      }
    ]);
    const events = new RecordingEventBus("team.agent.message");
    const { service, workspace } = await createRuntime(codexRunner, { events });
    const team = service.createTeam(makeTeam(workspace.id));
    const parentTask = await service.createTask({
      title: "Recover coordinator failures",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "codex",
      runnerConfig: {
        type: "codex",
        prompt: "Create one child task."
      }
    });
    await attachTaskToTeam(service, parentTask.id, team.id);

    const started = await service.startTask(parentTask.id);
    await waitForRunToFinish(service, parentTask.id);
    const reviewTask = await waitForTask(service, parentTask.id, (task) => task.column === "review");
    const subtasks = service.listTasks({}).filter((task) => task.parentTaskId === parentTask.id);
    const log = await service.getRunLog(started.run.id);

    expect(reviewTask.column).toBe("review");
    expect(subtasks).toHaveLength(1);
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          title: "Coordinator parse error",
          text: expect.stringContaining("Injected event bus failure")
        })
      ])
    );
  });
});
