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

function makeTeam(
  workspaceId: string,
  overrides: Partial<CreateTeamBody> = {}
): CreateTeamBody {
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
    autoApproveSubtasks: false,
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
    ],
    ...overrides
  };
}

describe("team execution integration", () => {
  it("creates a team task directly from createTask input", async () => {
    const codexRunner = new ScriptedCodexRunner([]);
    const { service, workspace } = await createRuntime(codexRunner);
    const team = service.createTeam(makeTeam(workspace.id));

    const task = await service.createTask({
      title: "Coordinate release readiness",
      description: "Drive the next multi-agent implementation batch.",
      workspaceId: workspace.id,
      teamId: team.id,
      column: "todo",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "echo should-be-overridden"
      }
    });

    expect(task.teamId).toBe(team.id);
    expect(task.runnerType).toBe("codex");
    expect(task.runnerConfig).toMatchObject({
      type: "codex",
      prompt: "Break the parent task into executable subtasks."
    });
  });

  it("rejects unknown team ids passed to createTask as invalid input", async () => {
    const codexRunner = new ScriptedCodexRunner([]);
    const { service, workspace } = await createRuntime(codexRunner);

    await expect(
      service.createTask({
        title: "Coordinate release readiness",
        description: "Drive the next multi-agent implementation batch.",
        workspaceId: workspace.id,
        teamId: "team-missing",
        column: "todo",
        runnerType: "shell",
        runnerConfig: {
          type: "shell",
          command: "echo should-be-overridden"
        }
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_TEAM"
    });
  });

  it("posts a human team message and publishes the existing team.agent.message event", async () => {
    const codexRunner = new ScriptedCodexRunner([]);
    const { events, service, workspace } = await createRuntime(codexRunner);
    const team = service.createTeam(makeTeam(workspace.id));
    const parentTask = await service.createTask({
      title: "Review coordinator proposal",
      description: "Collect feedback before execution starts.",
      workspaceId: workspace.id,
      teamId: team.id,
      column: "todo",
      runnerType: "shell",
      runnerConfig: {
        type: "shell",
        command: "echo should-be-overridden"
      }
    });

    const message = service.postHumanTeamMessage(
      team.id,
      parentTask.id,
      "Please split the rollout into API and UI subtasks."
    );

    expect(message).toMatchObject({
      teamId: team.id,
      parentTaskId: parentTask.id,
      taskId: parentTask.id,
      agentName: "User",
      senderType: "human",
      messageType: "feedback",
      content: "Please split the rollout into API and UI subtasks."
    });
    expect(service.listTeamMessages(team.id, parentTask.id)).toEqual([message]);
    expect(events.published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "team.agent.message",
          teamId: team.id,
          parentTaskId: parentTask.id,
          fromAgentId: "human",
          messageType: "feedback",
          payload: "Please split the rollout into API and UI subtasks."
        })
      ])
    );
  });

  it("rejects posting a human team message to a non-parent task thread", async () => {
    const codexRunner = new ScriptedCodexRunner([]);
    const { service, workspace } = await createRuntime(codexRunner);
    const team = service.createTeam(makeTeam(workspace.id));
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

    expect(() =>
      service.postHumanTeamMessage(team.id, unrelatedTask.id, "Need a human check-in.")
    ).toThrowError(/parentTaskId must reference a parent task/);
  });

  // 15s timeout: two sequential phases (coordinator run → proposal, then approve → subtask run)
  it("saves a coordinator proposal on run finish, then creates subtasks on approval", async () => {
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

    // After coordinator run: proposal is created, parent stays in "review", no subtasks yet.
    // saveProposal runs in afterRunFinished (end of handleExit chain), so poll via waitFor.
    // Once proposals exist, we know the full async chain completed (task column already "review").
    const proposals = await waitFor(() => {
      const items = service.listProposals(team.id, { parentTaskId: parentTask.id });
      return items.length > 0 ? items : undefined;
    });
    const proposal = proposals[0]!;
    const reviewParent = service.getTask(parentTask.id);

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
    expect(reviewParent.column).toBe("review");
    expect(service.listTasks({}).filter((task) => task.parentTaskId === parentTask.id)).toHaveLength(0);
    expect(proposal.status).toBe("pending");
    expect(proposal.drafts).toHaveLength(2);
    expect(events.published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "team.proposal.created", teamId: team.id, parentTaskId: parentTask.id })
      ])
    );

    // Approve the proposal: subtasks created and parent moved to "running" synchronously.
    await service.approveProposal(team.id, proposal.id);
    const finalParent = service.getTask(parentTask.id);
    const subtasks = service
      .listTasks({})
      .filter((task) => task.parentTaskId === parentTask.id)
      .sort((left, right) => left.order - right.order);
    const messages = service.listTeamMessages(team.id, parentTask.id);

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
        expect.objectContaining({ type: "team.agent.message", teamId: team.id, parentTaskId: parentTask.id }),
        expect.objectContaining({ type: "team.task.created", teamId: team.id, parentTaskId: parentTask.id })
      ])
    );
  }, 15_000);

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

    // Approve the proposal before subtasks are created.
    // Re-enable the scheduler so it auto-starts the subtask after approval.
    const settings = service.getSettings();
    await service.updateSettings({ ...settings, scheduler: { maxConcurrent: 3 } });
    const proposals = await waitFor(() => {
      const items = service.listProposals(team.id, { parentTaskId: parentTask.id });
      return items.length > 0 ? items : undefined;
    });
    await service.approveProposal(team.id, proposals[0]!.id);

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
  }, 15_000);

  it("keeps succeeded subtasks in review when autoApproveSubtasks is disabled", async () => {
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
        outputText: "Implemented.",
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
    await waitForRunToFinish(service, subtask.id);

    const reviewSubtask = await waitForTask(service, subtask.id, (task) => task.column === "review");
    const parent = service.getTask(parentTask.id);

    expect(reviewSubtask.lastRunStatus).toBe("succeeded");
    expect(reviewSubtask.rejected).toBe(false);
    expect(parent.column).toBe("running");
  });

  it("auto-approves succeeded subtasks when autoApproveSubtasks is enabled", async () => {
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
        outputText: "Implemented.",
        exit: { status: "succeeded", exitCode: 0 }
      }
    ]);
    const { service, workspace } = await createRuntime(codexRunner);
    const team = service.createTeam(
      makeTeam(workspace.id, { autoApproveSubtasks: true })
    );
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

    const doneSubtask = await waitForTask(service, subtask.id, (task) => task.column === "done");
    const parent = await waitForTask(service, parentTask.id, (task) => task.column === "review");

    expect(doneSubtask.lastRunStatus).toBe("succeeded");
    expect(doneSubtask.rejected).toBe(false);
    expect(parent.column).toBe("review");
  });

  it("auto-rejects failed subtasks when autoApproveSubtasks is enabled", async () => {
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
        outputText: "Implementation failed.",
        exit: { status: "failed", exitCode: 1 }
      }
    ]);
    const { service, workspace } = await createRuntime(codexRunner);
    const team = service.createTeam(
      makeTeam(workspace.id, { autoApproveSubtasks: true })
    );
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

    const doneSubtask = await waitForTask(service, subtask.id, (task) => task.column === "done");
    const parent = await waitForTask(service, parentTask.id, (task) => task.column === "review");

    expect(doneSubtask.lastRunStatus).toBe("failed");
    expect(doneSubtask.rejected).toBe(true);
    expect(parent.column).toBe("review");
  });

  it("waits for human approve/reject decisions before aggregating the parent task", async () => {
    const coordinatorOutput = JSON.stringify([
      {
        title: "Implement data model",
        description: "Add parentTaskId and teamAgentId wiring.",
        assignedAgent: "Worker",
        dependencies: []
      },
      {
        title: "Wire coordinator callbacks",
        description: "Hook run completion into child task creation.",
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
        outputText: "Subtask one complete.",
        exit: { status: "succeeded", exitCode: 0 }
      },
      {
        outputText: "Subtask two complete.",
        exit: { status: "succeeded", exitCode: 0 }
      }
    ]);
    const { service, workspace } = await createRuntime(codexRunner);
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

    await service.startTask(parentTask.id);
    await waitForRunToFinish(service, parentTask.id);
    const subtasks = await waitFor(() => {
      const items = service
        .listTasks({})
        .filter((task) => task.parentTaskId === parentTask.id)
        .sort((left, right) => left.order - right.order);
      return items.length === 2 ? items : undefined;
    });
    await waitForRunToFinish(service, subtasks[0]!.id);
    await waitForRunToFinish(service, subtasks[1]!.id);
    await waitForTask(service, subtasks[0]!.id, (task) => task.column === "review");
    await waitForTask(service, subtasks[1]!.id, (task) => task.column === "review");

    const approved = await service.approveTask(subtasks[0]!.id);
    expect(approved.column).toBe("done");
    expect(service.getTask(parentTask.id).column).toBe("running");

    const rejected = await service.rejectTask(subtasks[1]!.id, "No longer needed");
    expect(rejected.column).toBe("done");
    expect(rejected.rejected).toBe(true);

    const parent = await waitForTask(service, parentTask.id, (task) => task.column === "review");
    const messages = service.listTeamMessages(team.id, parentTask.id);

    expect(parent.column).toBe("review");
    expect(messages.some((message) => message.content.includes("No longer needed"))).toBe(true);
    expect(messages.at(-1)?.content).toContain("All subtasks reached a final decision");
  });

  it("retries review subtasks by moving them back to todo and rerunning them", async () => {
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
        outputText: "First attempt failed.",
        exit: { status: "failed", exitCode: 1 }
      },
      {
        outputText: "Second attempt succeeded.",
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
    await waitForRunToFinish(service, subtask.id);
    await waitForTask(service, subtask.id, (task) => task.column === "review");

    const retriedTask = await service.retryTask(subtask.id);
    expect(["todo", "running", "review"]).toContain(retriedTask.column);

    await waitFor(() => (service.listRuns(subtask.id).length >= 2 ? service.listRuns(subtask.id) : undefined));
    await waitFor(() => {
      const task = service.getTask(subtask.id);
      return task.column === "review" && task.lastRunStatus === "succeeded" ? task : undefined;
    });

    const runs = service.listRuns(subtask.id);
    const messages = service.listTeamMessages(team.id, parentTask.id);
    expect(runs).toHaveLength(2);
    expect(messages.some((message) => message.content.includes("requested retry"))).toBe(true);
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

  it("returns the parent task to review if proposal event publication fails", async () => {
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
    const events = new RecordingEventBus("team.proposal.created");
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
    const log = await service.getRunLog(started.run.id);

    expect(reviewTask.column).toBe("review");
    expect(service.listTasks({}).filter((task) => task.parentTaskId === parentTask.id)).toHaveLength(0);
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
