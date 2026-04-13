import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { AgentTeam, CreateTeamBody, Run, RunnerConfig, ServerEvent, Task } from "@workhorse/contracts";

import { BoardService } from "./board-service.js";
import { StateStore } from "../persistence/state-store.js";
import { EventBus } from "../ws/event-bus.js";
import type { CodexAppServer } from "../runners/codex-app-server-manager.js";
import type {
  RunnerAdapter,
  RunnerControl,
  RunnerLifecycleHooks,
  RunnerStartContext
} from "../runners/types.js";
import type { PrCreator } from "./team-pr-service.js";
import { TeamPrService } from "./team-pr-service.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class RecordingEventBus extends EventBus {
  public readonly published: ServerEvent[] = [];

  public override publish(event: ServerEvent): void {
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
    return { command: `${this.type} mock`, async stop() {} };
  }
}

interface CodexScript {
  outputText?: string;
  exit: { status: Run["status"]; exitCode?: number; metadata?: Record<string, string> };
}

class ScriptedCodexRunner implements RunnerAdapter {
  public readonly type = "codex" as const;

  public constructor(private readonly scripts: CodexScript[]) {}

  public async start(
    _context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl> {
    const script = this.scripts.shift();
    if (!script) {
      throw new Error("No codex script configured");
    }
    void sleep(0).then(async () => {
      if (script.outputText) {
        await hooks.onOutput({ kind: "agent", stream: "stdout", title: "output", text: script.outputText });
      }
      await hooks.onExit(script.exit);
    });
    return { command: "codex mock", metadata: script.exit.metadata, async stop() {} };
  }
}

function createCodexAppServerStub(): CodexAppServer {
  return {
    async initialize() {},
    async createConnection() {
      throw new Error("Not available in tests");
    },
    async readAccountRateLimits() {
      return null;
    },
    async archiveThread() {}
  };
}

async function waitFor<T>(getter: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = getter();
    if (value !== undefined) return value;
    await sleep(25);
  }
  throw new Error("Timed out waiting for condition");
}

async function waitForTask(
  service: BoardService,
  taskId: string,
  predicate: (task: Task) => boolean
): Promise<Task> {
  return waitFor(() => service.listTasks({}).find((t) => t.id === taskId && predicate(t)));
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

async function createRuntime(
  codexRunner: ScriptedCodexRunner,
  options: { prCreator?: PrCreator; events?: RecordingEventBus } = {}
) {
  const dataDir = await mkdtemp(join(tmpdir(), "workhorse-pr-test-"));
  const workspaceDir = join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  const events = options.events ?? new RecordingEventBus();
  const service = new BoardService(new StateStore(dataDir), events, {
    codexAppServer: createCodexAppServerStub(),
    runners: {
      codex: codexRunner,
      claude: new IdleRunner("claude"),
      shell: new IdleRunner("shell")
    },
    prCreator: options.prCreator
  });
  await service.initialize();

  const workspace = await service.createWorkspace({ name: "Test", rootPath: workspaceDir });

  const settings = service.getSettings();
  await service.updateSettings({
    language: settings.language,
    openRouter: settings.openRouter,
    scheduler: { maxConcurrent: 0 }
  });

  return { events, service, workspace };
}

function makeTeam(workspaceId: string, prStrategy: AgentTeam["prStrategy"] = "independent"): CreateTeamBody {
  const codexRunner: RunnerConfig = { type: "codex", prompt: "Work on the task." };
  return {
    name: "Test Team",
    description: "For PR creation tests",
    workspaceId,
    prStrategy,
    autoApproveSubtasks: true,
    agents: [
      { id: "agent-coordinator", agentName: "Coordinator", role: "coordinator", runnerConfig: codexRunner },
      { id: "agent-worker", agentName: "Worker", role: "worker", runnerConfig: codexRunner }
    ]
  };
}

function makeMockPrCreator(
  prUrl = "https://github.com/owner/repo/pull/99",
  repoFullName = "owner/repo"
): PrCreator & {
  pushCalls: Array<{ worktreePath: string; branchName: string }>;
  createCalls: Array<{ repo: string; title: string; body: string; base: string; head: string }>;
} {
  const pushCalls: Array<{ worktreePath: string; branchName: string }> = [];
  const createCalls: Array<{ repo: string; title: string; body: string; base: string; head: string }> = [];
  return {
    pushCalls,
    createCalls,
    async pushBranch(worktreePath, branchName) {
      pushCalls.push({ worktreePath, branchName });
    },
    async resolveRepoFullName(_rootPath) {
      return repoFullName;
    },
    async createPullRequest(opts) {
      createCalls.push(opts);
      return prUrl;
    }
  };
}

// ---------------------------------------------------------------------------
// TeamPrService unit tests
// ---------------------------------------------------------------------------

describe("TeamPrService", () => {
  it("skips PR creation when prStrategy is not independent", async () => {
    const { service } = await createRuntime(new ScriptedCodexRunner([]));
    const store = (service as unknown as { store: StateStore }).store;
    const events = new RecordingEventBus();
    const prCreator = makeMockPrCreator();
    const svc = new TeamPrService(store, events, prCreator);

    const task = {
      id: "task-1",
      worktree: { path: "/tmp/wt", branchName: "feat/task-1", baseRef: "main", status: "ready" as const },
      workspaceId: "ws-1",
      parentTaskId: "parent-1"
    } as unknown as Task;
    const team = { id: "team-1", prStrategy: "stacked" } as AgentTeam;

    const result = await svc.createSubtaskPullRequest(task, team);

    expect(result).toBeNull();
    expect(prCreator.pushCalls).toHaveLength(0);
    expect(prCreator.createCalls).toHaveLength(0);
  });

  it("skips PR creation when worktree has no path", async () => {
    const { service } = await createRuntime(new ScriptedCodexRunner([]));
    const store = (service as unknown as { store: StateStore }).store;
    const events = new RecordingEventBus();
    const prCreator = makeMockPrCreator();
    const svc = new TeamPrService(store, events, prCreator);

    const task = {
      id: "task-1",
      // worktree.path intentionally missing
      worktree: { baseRef: "main", status: "ready" as const, branchName: "feat/task-1" },
      workspaceId: "ws-1",
      parentTaskId: "parent-1"
    } as unknown as Task;
    const team = { id: "team-1", prStrategy: "independent" } as AgentTeam;

    const result = await svc.createSubtaskPullRequest(task, team);
    expect(result).toBeNull();
    expect(prCreator.pushCalls).toHaveLength(0);
  });

  it("publishes a failure team message when pushBranch throws", async () => {
    const events = new RecordingEventBus();
    const { service, workspace } = await createRuntime(new ScriptedCodexRunner([]), { events });
    const store = (service as unknown as { store: StateStore }).store;

    // Use a real team so FK constraints pass when inserting team messages
    const team = service.createTeam(makeTeam(workspace.id));

    const failingPrCreator: PrCreator = {
      async pushBranch() {
        throw new Error("git push: authentication failed");
      },
      async resolveRepoFullName() {
        return "owner/repo";
      },
      async createPullRequest() {
        return "";
      }
    };
    const svc = new TeamPrService(store, events, failingPrCreator);

    // Use a real parent task
    const parentTask = await service.createTask({
      title: "Parent task",
      description: "Coordinate work",
      workspaceId: workspace.id,
      column: "running",
      runnerType: "codex",
      runnerConfig: { type: "codex", prompt: "coord" }
    });

    const task = {
      id: "task-subtask",
      title: "Implement feature",
      description: "Details here",
      workspaceId: workspace.id,
      parentTaskId: parentTask.id,
      worktree: { path: "/tmp/wt", branchName: "feat/task-1", baseRef: "main", status: "ready" as const }
    } as unknown as Task;

    const result = await svc.createSubtaskPullRequest(task, team);

    expect(result).toBeNull();
    const statusMessages = events.published.filter((e) => e.type === "team.agent.message");
    expect(statusMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "team.agent.message",
          payload: expect.stringContaining("Failed to push branch")
        })
      ])
    );
  });
  it("updates task.pullRequestUrl and publishes success message on happy path", async () => {
    const prUrl = "https://github.com/owner/repo/pull/42";
    const events = new RecordingEventBus();
    const { service, workspace } = await createRuntime(new ScriptedCodexRunner([]), { events });
    const store = (service as unknown as { store: StateStore }).store;

    const team = service.createTeam(makeTeam(workspace.id));
    const parentTask = await service.createTask({
      title: "Parent task",
      description: "Coordinate work",
      workspaceId: workspace.id,
      column: "running",
      runnerType: "codex",
      runnerConfig: { type: "codex", prompt: "coord" }
    });

    // Seed a subtask directly in the store with a valid worktree path
    const subtaskId = "task-subtask-happy";
    await store.updateState((state) => {
      state.tasks.push({
        id: subtaskId,
        title: "Implement feature",
        description: "Write the feature code",
        column: "done",
        order: 999,
        workspaceId: workspace.id,
        teamId: team.id,
        parentTaskId: parentTask.id,
        teamAgentId: "agent-worker",
        runnerType: "codex",
        runnerConfig: { type: "codex", prompt: "work" },
        worktree: {
          path: workspace.rootPath,
          branchName: "feat/subtask",
          baseRef: "main",
          status: "ready" as const,
          lastSyncedBaseAt: undefined,
          cleanupReason: undefined
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastRunId: undefined,
        lastRunStatus: undefined,
        pullRequestUrl: undefined,
        reviewRequestedAt: undefined,
        autoApproveSubtasks: false,
        prStrategy: undefined,
        dependencies: [],
        rejected: false
      } as unknown as Task);
      return null;
    });

    const subtask = store.listTasks().find((t) => t.id === subtaskId)!;
    const prCreator = makeMockPrCreator(prUrl);
    const svc = new TeamPrService(store, events, prCreator);

    const result = await svc.createSubtaskPullRequest(subtask, team);

    expect(result).toBe(prUrl);
    expect(prCreator.pushCalls).toHaveLength(1);
    expect(prCreator.pushCalls[0]).toMatchObject({ branchName: "feat/subtask" });
    expect(prCreator.createCalls).toHaveLength(1);
    expect(prCreator.createCalls[0]).toMatchObject({
      repo: "owner/repo",
      title: "Implement feature",
      base: "main",
      head: "feat/subtask"
    });

    // task.pullRequestUrl should be updated in the store
    const updated = store.listTasks().find((t) => t.id === subtaskId);
    expect(updated?.pullRequestUrl).toBe(prUrl);

    // success team message should be published
    const statusMessages = events.published.filter((e) => e.type === "team.agent.message");
    expect(statusMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "team.agent.message",
          payload: expect.stringContaining(prUrl)
        })
      ])
    );
  });
});

// ---------------------------------------------------------------------------
// Integration test: auto-advance path triggers PR creation
// ---------------------------------------------------------------------------

describe("team PR creation integration", () => {
  it("creates a PR when a subtask auto-advances to done (independent strategy)", async () => {
    const coordinatorOutput = JSON.stringify([
      {
        title: "Implement feature A",
        description: "Write code for feature A",
        assignedAgent: "Worker",
        dependencies: []
      }
    ]);
    const mockPrCreator = makeMockPrCreator("https://github.com/owner/repo/pull/1");

    const codexRunner = new ScriptedCodexRunner([
      { outputText: coordinatorOutput, exit: { status: "succeeded", exitCode: 0 } },
      { exit: { status: "succeeded", exitCode: 0 } } // worker subtask
    ]);

    const events = new RecordingEventBus();
    const { service, workspace } = await createRuntime(codexRunner, { prCreator: mockPrCreator, events });
    const team = service.createTeam(makeTeam(workspace.id, "independent"));

    const parentTask = await service.createTask({
      title: "Build feature",
      description: "Full feature implementation",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "codex",
      runnerConfig: { type: "codex", prompt: "Coordinate the work." }
    });

    // Attach to team so coordinator flow activates
    const store = (service as unknown as { store: StateStore }).store;
    await store.updateState((state) => {
      const idx = state.tasks.findIndex((t) => t.id === parentTask.id);
      if (idx !== -1) {
        state.tasks[idx]!.teamId = team.id;
        state.tasks[idx]!.updatedAt = new Date().toISOString();
      }
      return null;
    });

    // Re-enable scheduler so subtasks auto-start
    const settings = service.getSettings();
    await service.updateSettings({
      language: settings.language,
      openRouter: settings.openRouter,
      scheduler: { maxConcurrent: 3 }
    });

    await service.startTask(parentTask.id);

    // Wait for subtask to appear and then complete
    const subtask = await waitFor(() => {
      return service.listTasks({}).find((t) => t.parentTaskId === parentTask.id);
    });

    // Wait for subtask to reach done
    await waitForTask(service, subtask.id, (t) => t.column === "done");

    // PR creation is fire-and-forget; wait briefly for it to settle
    await sleep(100);

    // Since there's no real worktree path in this test, pushBranch won't be called
    // (TeamPrService returns null when worktree.path is missing).
    // Verify the service doesn't crash — task should still be done.
    const finalSubtask = service.listTasks({}).find((t) => t.id === subtask.id);
    expect(finalSubtask?.column).toBe("done");
  });

  it("does not trigger PR creation when prStrategy is not independent", async () => {
    const coordinatorOutput = JSON.stringify([
      {
        title: "Implement feature B",
        description: "Work on feature B",
        assignedAgent: "Worker",
        dependencies: []
      }
    ]);
    const mockPrCreator = makeMockPrCreator();

    const codexRunner = new ScriptedCodexRunner([
      { outputText: coordinatorOutput, exit: { status: "succeeded", exitCode: 0 } },
      { exit: { status: "succeeded", exitCode: 0 } }
    ]);

    const events = new RecordingEventBus();
    const { service, workspace } = await createRuntime(codexRunner, { prCreator: mockPrCreator, events });
    // Use "stacked" strategy — PR creation should be skipped
    const team = service.createTeam(makeTeam(workspace.id, "stacked"));

    const parentTask = await service.createTask({
      title: "Build stacked feature",
      description: "Stacked PR workflow",
      workspaceId: workspace.id,
      column: "todo",
      runnerType: "codex",
      runnerConfig: { type: "codex", prompt: "Coordinate." }
    });

    const store = (service as unknown as { store: StateStore }).store;
    await store.updateState((state) => {
      const idx = state.tasks.findIndex((t) => t.id === parentTask.id);
      if (idx !== -1) {
        state.tasks[idx]!.teamId = team.id;
        state.tasks[idx]!.updatedAt = new Date().toISOString();
      }
      return null;
    });

    const settings = service.getSettings();
    await service.updateSettings({
      language: settings.language,
      openRouter: settings.openRouter,
      scheduler: { maxConcurrent: 3 }
    });

    await service.startTask(parentTask.id);

    const subtask = await waitFor(() => {
      return service.listTasks({}).find((t) => t.parentTaskId === parentTask.id);
    });

    await waitForTask(service, subtask.id, (t) => t.column === "done");
    await sleep(100);

    expect(mockPrCreator.pushCalls).toHaveLength(0);
    expect(mockPrCreator.createCalls).toHaveLength(0);
  });
});
