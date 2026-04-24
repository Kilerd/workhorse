import { access, mkdir, readFile, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, asc, eq } from "drizzle-orm";

import type {
  AccountAgent,
  AgentRole,
  AgentSession,
  AppState,
  CoordinatorState,
  GlobalSettings,
  Message,
  MessageKind,
  MessageSender,
  Plan,
  PlanDraft,
  PlanStatus,
  Run,
  RunLogEntry,
  RunnerConfig,
  Task,
  Thread,
  ThreadKind,
  Workspace,
  WorkspaceAgent
} from "@workhorse/contracts";

import { parseRunLogEntries } from "../lib/run-log.js";
import { resolveWorkspaceCodexSettings } from "../lib/codex-settings.js";
import { AppError } from "../lib/errors.js";
import { resolveGlobalSettings } from "../lib/global-settings.js";
import { createId } from "../lib/id.js";
import { createTaskWorktree } from "../lib/task-worktree.js";
import { resolveWorkspacePromptTemplates } from "../lib/workspace-prompt-templates.js";
import * as schema from "./schema.js";

const SETTINGS_KEY = "global";
const AGENT_DRIVEN_BOARD_BACKFILL_MARKER = "agent_driven_board_backfill_v1";
const DEFAULT_CODEX_RUNNER_CONFIG: RunnerConfig = {
  type: "codex",
  prompt:
    "You are a workhorse agent powered by Codex. Coordinate or implement the task below end-to-end, make the required changes, and report concrete results. Prefer minimal diffs and verify your work before finishing.",
  model: { mode: "builtin", id: "gpt-5.4", reasoningEffort: "medium" },
  approvalMode: "default"
};

// ---------------------------------------------------------------------------
// JSON migration helpers (kept for one-shot migration from legacy state.json)
// ---------------------------------------------------------------------------

function migrateJsonState(state: AppState): AppState {
  const resolvedSettings = resolveGlobalSettings(state.settings);
  const workspaceList = (Array.isArray(state.workspaces) ? state.workspaces : []).map(
    (workspace) =>
      ({
        ...workspace,
        codexSettings: resolveWorkspaceCodexSettings(workspace),
        promptTemplates: resolveWorkspacePromptTemplates(workspace)
      }) satisfies Workspace
  );
  const workspaceById = new Map(workspaceList.map((ws) => [ws.id, ws]));
  const taskList = (Array.isArray(state.tasks) ? state.tasks : []).map((task) => {
    const withWorktree =
      "worktree" in task && task.worktree
        ? ({ ...task, taskKind: (task as Partial<Task>).taskKind ?? "user" } as Task)
        : (() => {
            const workspace = workspaceById.get(task.workspaceId);
            return {
              ...task,
              taskKind: (task as Partial<Task>).taskKind ?? "user",
              worktree: createTaskWorktree(task.id, task.title, { workspace })
            } as Task;
          })();

    if (!Array.isArray(withWorktree.dependencies)) {
      return { ...withWorktree, dependencies: [] } satisfies Task;
    }
    return withWorktree;
  });

  return {
    schemaVersion: state.schemaVersion ?? 9,
    settings: resolvedSettings,
    workspaces: workspaceList,
    tasks: taskList,
    runs: Array.isArray(state.runs) ? state.runs : []
  };
}

function sanitizeStateForPersistence(state: AppState): AppState {
  const taskList = Array.isArray(state.tasks) ? state.tasks : [];
  const taskIds = new Set(taskList.map((task) => task.id));
  const runList = (Array.isArray(state.runs) ? state.runs : []).filter((run) =>
    taskIds.has(run.taskId)
  );
  const runIds = new Set(runList.map((run) => run.id));

  return {
    ...state,
    tasks: taskList.map((task) => ({
      ...task,
      dependencies: Array.isArray(task.dependencies)
        ? task.dependencies.filter((depId) => taskIds.has(depId))
        : [],
      lastRunId:
        typeof task.lastRunId === "string" && runIds.has(task.lastRunId)
          ? task.lastRunId
          : undefined,
      continuationRunId:
        typeof task.continuationRunId === "string" &&
        runIds.has(task.continuationRunId)
          ? task.continuationRunId
          : undefined
    })),
    runs: runList
  };
}

// ---------------------------------------------------------------------------
// Row <-> domain type conversions
// ---------------------------------------------------------------------------

type WorkspaceRow = typeof schema.workspaces.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;
type RunLogEntryRow = typeof schema.runLogEntries.$inferSelect;
type AgentRow = typeof schema.agents.$inferSelect;
type WorkspaceAgentRow = typeof schema.workspaceAgents.$inferSelect;
type ThreadRow = typeof schema.threads.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;
type AgentSessionRow = typeof schema.agentSessions.$inferSelect;
type PlanRow = typeof schema.plans.$inferSelect;

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    isGitRepo: Boolean(row.isGitRepo),
    codexSettings: JSON.parse(row.codexSettings),
    promptTemplates: row.promptTemplates ? JSON.parse(row.promptTemplates) : undefined,
    prStrategy:
      (row.prStrategy as "independent" | "stacked" | "single") ?? undefined,
    autoApproveSubtasks: row.autoApproveSubtasks ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function workspaceToRow(ws: Workspace): typeof schema.workspaces.$inferInsert {
  return {
    id: ws.id,
    name: ws.name,
    rootPath: ws.rootPath,
    isGitRepo: ws.isGitRepo,
    codexSettings: JSON.stringify(ws.codexSettings),
    promptTemplates: ws.promptTemplates != null ? JSON.stringify(ws.promptTemplates) : null,
    prStrategy: ws.prStrategy ?? "independent",
    autoApproveSubtasks: ws.autoApproveSubtasks ?? false,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt
  };
}

function rowToAgent(row: AgentRow): AccountAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    runnerConfig: normalizeRunnerConfig(JSON.parse(row.runnerConfig)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeRunnerConfig(raw: unknown): RunnerConfig {
  if (!raw || typeof raw !== "object") {
    return structuredClone(DEFAULT_CODEX_RUNNER_CONFIG);
  }

  const config = raw as Record<string, unknown>;

  if (config.type === "shell") {
    return structuredClone(DEFAULT_CODEX_RUNNER_CONFIG);
  }

  if (typeof config.model === "string") {
    config.model = { mode: "custom", id: config.model };
  }

  return config as unknown as RunnerConfig;
}

function agentToRow(agent: AccountAgent): typeof schema.agents.$inferInsert {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? null,
    runnerConfig: JSON.stringify(agent.runnerConfig),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}

function rowToWorkspaceAgent(agentRow: AgentRow, waRow: WorkspaceAgentRow): WorkspaceAgent {
  return {
    ...rowToAgent(agentRow),
    role: waRow.role as AgentRole,
    workspaceDescription: waRow.description ?? undefined
  };
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as ThreadKind,
    taskId: row.taskId ?? undefined,
    coordinatorAgentId: row.coordinatorAgentId ?? undefined,
    coordinatorState: row.coordinatorState as CoordinatorState,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt ?? undefined
  };
}

function rowToMessage(row: MessageRow): Message {
  let sender: MessageSender;
  if (row.senderType === "user") {
    sender = { type: "user" };
  } else if (row.senderType === "system") {
    sender = { type: "system" };
  } else if (row.senderType === "agent") {
    sender = { type: "agent", agentId: row.senderAgentId ?? "" };
  } else {
    // Defensive fallback — unknown sender types are treated as system.
    sender = { type: "system" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }

  return {
    id: row.id,
    threadId: row.threadId,
    sender,
    kind: row.kind as MessageKind,
    payload,
    consumedByRunId: row.consumedByRunId ?? undefined,
    createdAt: row.createdAt
  };
}

function rowToAgentSession(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    threadId: row.threadId,
    runnerSessionKey: row.runnerSessionKey ?? undefined,
    createdAt: row.createdAt
  };
}

function rowToPlan(row: PlanRow): Plan {
  let drafts: PlanDraft[] = [];
  try {
    const parsed = JSON.parse(row.drafts);
    if (Array.isArray(parsed)) {
      drafts = parsed as PlanDraft[];
    }
  } catch {
    drafts = [];
  }
  return {
    id: row.id,
    threadId: row.threadId,
    proposerAgentId: row.proposerAgentId,
    status: row.status as PlanStatus,
    drafts,
    approvedAt: row.approvedAt ?? undefined,
    createdAt: row.createdAt
  };
}

function rowToTask(row: TaskRow, depIds: string[]): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    workspaceId: row.workspaceId,
    column: row.column as Task["column"],
    order: row.taskOrder,
    dependencies: depIds,
    plan: row.plan ?? undefined,
    worktree: JSON.parse(row.worktree),
    lastRunId: row.lastRunId ?? undefined,
    lastRunStatus: row.lastRunStatus
      ? (row.lastRunStatus as Task["lastRunStatus"])
      : undefined,
    continuationRunId: row.continuationRunId ?? undefined,
    pullRequestUrl: row.pullRequestUrl ?? undefined,
    pullRequest: row.pullRequest ? JSON.parse(row.pullRequest) : undefined,
    rejected: row.rejected,
    cancelledAt: row.cancelledAt ?? undefined,
    taskKind: (row.taskKind as Task["taskKind"] | null) ?? "user",
    parentTaskId: row.parentTaskId ?? undefined,
    source: (row.source as Task["source"] | null) ?? "user",
    planId: row.planId ?? undefined,
    assigneeAgentId: row.assigneeAgentId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function taskToRow(task: Task): typeof schema.tasks.$inferInsert {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    workspaceId: task.workspaceId,
    column: task.column,
    taskOrder: task.order,
    plan: task.plan ?? null,
    worktree: JSON.stringify(task.worktree),
    lastRunId: task.lastRunId ?? null,
    lastRunStatus: task.lastRunStatus ?? null,
    continuationRunId: task.continuationRunId ?? null,
    pullRequestUrl: task.pullRequestUrl ?? null,
    pullRequest: task.pullRequest != null ? JSON.stringify(task.pullRequest) : null,
    rejected: task.rejected ?? false,
    cancelledAt: task.cancelledAt ?? null,
    taskKind: task.taskKind,
    parentTaskId: task.parentTaskId ?? null,
    source: task.source ?? "user",
    planId: task.planId ?? null,
    assigneeAgentId: task.assigneeAgentId ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status as Run["status"],
    runnerType: row.runnerType as Run["runnerType"],
    command: row.command,
    pid: row.pid ?? undefined,
    exitCode: row.exitCode ?? undefined,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? undefined,
    logFile: row.logFile ?? undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, string>) : undefined
  };
}

function runToRow(run: Run): typeof schema.runs.$inferInsert {
  return {
    id: run.id,
    taskId: run.taskId,
    status: run.status,
    runnerType: run.runnerType,
    command: run.command,
    pid: run.pid ?? null,
    exitCode: run.exitCode ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    logFile: run.logFile ?? null,
    metadata: run.metadata != null ? JSON.stringify(run.metadata) : null
  };
}

function rowToLogEntry(row: RunLogEntryRow): RunLogEntry {
  return {
    id: row.id,
    runId: row.runId,
    timestamp: row.timestamp,
    stream: row.stream as RunLogEntry["stream"],
    kind: row.kind as RunLogEntry["kind"],
    text: row.entryText,
    title: row.title ?? undefined,
    source: row.source ?? undefined,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, string>)
      : undefined
  };
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

export class StateStore {
  public readonly dataDir: string;

  /** Kept for legacy: path of the old JSON state file (migration detection). */
  public readonly stateFile: string;

  /** Kept for legacy: path of the old NDJSON log directory (migration source). */
  public readonly logsDir: string;

  private sqlite!: InstanceType<typeof Database>;

  private db!: ReturnType<typeof drizzle<typeof schema>>;

  private state: AppState = {
    schemaVersion: 9,
    settings: resolveGlobalSettings(undefined),
    workspaces: [],
    tasks: [],
    runs: []
  };

  private writeBarrier: Promise<void> = Promise.resolve();

  public constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.stateFile = dataDir === ":memory:" ? ":memory:" : join(dataDir, "state.json");
    this.logsDir = dataDir === ":memory:" ? ":memory:" : join(dataDir, "logs");
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  public async load(): Promise<void> {
    const isMemory = this.dataDir === ":memory:";

    if (!isMemory) {
      await mkdir(this.dataDir, { recursive: true });
    }

    const dbPath = isMemory ? ":memory:" : join(this.dataDir, "workhorse.db");
    this.sqlite = new Database(dbPath);
    if (!isMemory) {
      this.sqlite.pragma("journal_mode = WAL");
    }
    this.sqlite.pragma("foreign_keys = ON");

    this.db = drizzle(this.sqlite, { schema });
    this.initSchema();

    if (!isMemory) {
      const needsMigration = await this.detectJsonMigration();
      if (needsMigration) {
        await this.runJsonMigration();
      }
    }

    this.state = this.readStateFromDb();
  }

  // -------------------------------------------------------------------------
  // Public read API
  // -------------------------------------------------------------------------

  public snapshot(): AppState {
    return {
      schemaVersion: this.state.schemaVersion,
      settings: {
        ...this.state.settings,
        openRouter: { ...this.state.settings.openRouter }
      },
      workspaces: [...this.state.workspaces],
      tasks: [...this.state.tasks],
      runs: [...this.state.runs]
    };
  }

  public getSettings(): GlobalSettings {
    return {
      ...this.state.settings,
      openRouter: { ...this.state.settings.openRouter }
    };
  }

  public listWorkspaces(): Workspace[] {
    return [...this.state.workspaces];
  }

  public listTasks(): Task[] {
    return [...this.state.tasks];
  }

  public listRuns(): Run[] {
    return [...this.state.runs];
  }

  // -------------------------------------------------------------------------
  // Public write API
  // -------------------------------------------------------------------------

  public setWorkspaces(workspaces: Workspace[]): void {
    this.state.workspaces = workspaces;
  }

  public setSettings(settings: GlobalSettings): void {
    this.state.settings = settings;
  }

  public setTasks(tasks: Task[]): void {
    this.state.tasks = tasks;
  }

  public setRuns(runs: Run[]): void {
    this.state.runs = runs;
  }

  /** Persists the current in-memory state to SQLite. */
  public async save(): Promise<void> {
    await this.withWriteLock(() => {
      const normalized = sanitizeStateForPersistence(this.state);
      this.persistState(normalized);
      this.state = normalized;
    });
  }

  /** Atomically updates state within a write lock and persists. */
  public async updateState<T>(updater: (state: AppState) => T): Promise<T> {
    return this.withWriteLock(async () => {
      const nextState = structuredClone(this.state) as AppState;
      const result = updater(nextState);
      const normalized = sanitizeStateForPersistence(nextState);
      this.persistState(normalized);
      this.state = normalized;
      return result;
    });
  }

  /** Atomically updates a single task. */
  public async updateTask(taskId: string, updater: (task: Task) => Task): Promise<Task> {
    return this.updateState((state) => {
      const taskIndex = state.tasks.findIndex((task) => task.id === taskId);
      if (taskIndex === -1) {
        throw new AppError(404, "TASK_NOT_FOUND", "Task not found");
      }

      state.tasks[taskIndex] = updater(state.tasks[taskIndex]!);
      return state.tasks[taskIndex];
    });
  }

  // -------------------------------------------------------------------------
  // Log entries (go directly to SQLite, not buffered in memory)
  // -------------------------------------------------------------------------

  /** Returns a legacy file path string (kept for backward compat with callers). */
  public createLogPath(runId: string): string {
    if (this.dataDir === ":memory:") {
      return `:memory:/${runId}.log`;
    }
    return join(this.logsDir, `${runId}.log`);
  }

  public async readLogEntries(runId: string): Promise<RunLogEntry[]> {
    const rows = this.db
      .select()
      .from(schema.runLogEntries)
      .where(eq(schema.runLogEntries.runId, runId))
      .orderBy(schema.runLogEntries.timestamp)
      .all();
    return rows.map(rowToLogEntry);
  }

  public async appendLogEntry(runId: string, entry: RunLogEntry): Promise<void> {
    this.db
      .insert(schema.runLogEntries)
      .values({
        id: entry.id,
        runId: entry.runId,
        timestamp: entry.timestamp,
        stream: entry.stream,
        kind: entry.kind,
        entryText: entry.text,
        title: entry.title ?? null,
        source: entry.source ?? null,
        metadata: entry.metadata != null ? JSON.stringify(entry.metadata) : null
      })
      .run();
  }

  // -------------------------------------------------------------------------
  // Account-level Agent CRUD (Phase 4)
  // -------------------------------------------------------------------------

  public listAgents(): AccountAgent[] {
    return this.db.select().from(schema.agents).all().map(rowToAgent);
  }

  public getAgent(agentId: string): AccountAgent | null {
    const row = this.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .get();
    return row ? rowToAgent(row) : null;
  }

  public createAgent(agent: AccountAgent): AccountAgent {
    this.db.insert(schema.agents).values(agentToRow(agent)).run();
    return agent;
  }

  public updateAgent(
    agentId: string,
    updates: Partial<Pick<AccountAgent, "name" | "description" | "runnerConfig">>
  ): AccountAgent | null {
    const existing = this.getAgent(agentId);
    if (!existing) {
      return null;
    }
    const updated: AccountAgent = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    this.db
      .update(schema.agents)
      .set({
        name: updated.name,
        description: updated.description ?? null,
        runnerConfig: JSON.stringify(updated.runnerConfig),
        updatedAt: updated.updatedAt
      })
      .where(eq(schema.agents.id, agentId))
      .run();
    return updated;
  }

  public deleteAgent(agentId: string): boolean {
    const result = this.db
      .delete(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .run();
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Workspace Agent mounting (Phase 4)
  // -------------------------------------------------------------------------

  public listWorkspaceAgents(workspaceId: string): WorkspaceAgent[] {
    const rows = this.db
      .select()
      .from(schema.workspaceAgents)
      .innerJoin(schema.agents, eq(schema.workspaceAgents.agentId, schema.agents.id))
      .where(eq(schema.workspaceAgents.workspaceId, workspaceId))
      .all();
    return rows.map((row) => rowToWorkspaceAgent(row.agents, row.workspace_agents));
  }

  public getWorkspaceAgent(workspaceId: string, agentId: string): WorkspaceAgent | null {
    const row = this.db
      .select()
      .from(schema.workspaceAgents)
      .innerJoin(schema.agents, eq(schema.workspaceAgents.agentId, schema.agents.id))
      .where(
        and(
          eq(schema.workspaceAgents.workspaceId, workspaceId),
          eq(schema.workspaceAgents.agentId, agentId)
        )
      )
      .get();
    return row ? rowToWorkspaceAgent(row.agents, row.workspace_agents) : null;
  }

  public mountAgentToWorkspace(
    workspaceId: string,
    agentId: string,
    role: AgentRole,
    workspaceDescription?: string
  ): WorkspaceAgent {
    return this.sqlite.transaction(() => {
      if (role === "coordinator") {
        this.ensureSingleCoordinator(workspaceId);
      }
      const agent = this.getAgent(agentId);
      if (!agent) {
        throw new AppError(404, "AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
      }
      const now = new Date().toISOString();
      const description = workspaceDescription?.trim() || null;
      this.db
        .insert(schema.workspaceAgents)
        .values({ workspaceId, agentId, role, description, createdAt: now })
        .run();
      return {
        ...agent,
        role,
        workspaceDescription: description ?? undefined
      };
    })();
  }

  public unmountAgentFromWorkspace(workspaceId: string, agentId: string): boolean {
    const result = this.db
      .delete(schema.workspaceAgents)
      .where(
        and(
          eq(schema.workspaceAgents.workspaceId, workspaceId),
          eq(schema.workspaceAgents.agentId, agentId)
        )
      )
      .run();
    return result.changes > 0;
  }

  public updateWorkspaceAgentRole(
    workspaceId: string,
    agentId: string,
    role: AgentRole
  ): WorkspaceAgent | null {
    return this.updateWorkspaceAgent(workspaceId, agentId, { role });
  }

  public updateWorkspaceAgent(
    workspaceId: string,
    agentId: string,
    updates: { role?: AgentRole; workspaceDescription?: string }
  ): WorkspaceAgent | null {
    return this.sqlite.transaction(() => {
      const role = updates.role;
      if (role === "coordinator") {
        this.ensureSingleCoordinator(workspaceId, agentId);
      }
      const set: Partial<typeof schema.workspaceAgents.$inferInsert> = {};
      if (role) {
        set.role = role;
      }
      if (updates.workspaceDescription !== undefined) {
        set.description = updates.workspaceDescription.trim() || null;
      }
      if (Object.keys(set).length === 0) {
        return this.getWorkspaceAgent(workspaceId, agentId);
      }
      const result = this.db
        .update(schema.workspaceAgents)
        .set(set)
        .where(
          and(
            eq(schema.workspaceAgents.workspaceId, workspaceId),
            eq(schema.workspaceAgents.agentId, agentId)
          )
        )
        .run();
      if (result.changes === 0) {
        return null;
      }
      return this.getWorkspaceAgent(workspaceId, agentId);
    })();
  }

  // -------------------------------------------------------------------------
  // Workspace coordination config (Phase 4)
  // -------------------------------------------------------------------------

  // Updates both DB and the in-memory state cache. Workspace objects follow the
  // existing pattern of being kept in memory (unlike agents, which are pure-DB)
  // because many hot-path reads go through this.state.workspaces without a DB
  // round-trip (e.g. listWorkspaces, requireTask workspace lookup).
  public updateWorkspaceConfig(
    workspaceId: string,
    config: Partial<Pick<Workspace, "prStrategy" | "autoApproveSubtasks">>
  ): Workspace | null {
    const workspaces = this.state.workspaces;
    const idx = workspaces.findIndex((ws) => ws.id === workspaceId);
    if (idx === -1) {
      return null;
    }
    const updated: Workspace = {
      ...workspaces[idx]!,
      ...config,
      updatedAt: new Date().toISOString()
    };
    this.db
      .update(schema.workspaces)
      .set({
        prStrategy: updated.prStrategy ?? "independent",
        autoApproveSubtasks: updated.autoApproveSubtasks ?? false,
        updatedAt: updated.updatedAt
      })
      .where(eq(schema.workspaces.id, workspaceId))
      .run();
    this.state.workspaces[idx] = updated;
    return updated;
  }

  // -------------------------------------------------------------------------
  // Threads / Messages / Agent Sessions (Spec 04)
  // -------------------------------------------------------------------------

  public insertThread(thread: Thread): void {
    this.db
      .insert(schema.threads)
      .values({
        id: thread.id,
        workspaceId: thread.workspaceId,
        kind: thread.kind,
        taskId: thread.taskId ?? null,
        coordinatorAgentId: thread.coordinatorAgentId ?? null,
        coordinatorState: thread.coordinatorState,
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt ?? null
      })
      .run();
  }

  public getThread(id: string): Thread | null {
    const row = this.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, id))
      .get();
    return row ? rowToThread(row) : null;
  }

  public listThreadsByWorkspace(workspaceId: string): Thread[] {
    return this.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.workspaceId, workspaceId))
      .orderBy(asc(schema.threads.createdAt))
      .all()
      .map(rowToThread);
  }

  public archiveThread(id: string, archivedAt: string): Thread | null {
    const result = this.sqlite
      .prepare(
        `UPDATE threads SET archived_at = ? WHERE id = ? AND archived_at IS NULL`
      )
      .run(archivedAt, id);
    if (result.changes === 0) {
      return this.getThread(id);
    }
    return this.getThread(id);
  }

  public updateThreadCoordinatorAgent(
    id: string,
    coordinatorAgentId: string
  ): Thread | null {
    const result = this.sqlite
      .prepare(`UPDATE threads SET coordinator_agent_id = ? WHERE id = ?`)
      .run(coordinatorAgentId, id);
    if (result.changes === 0) {
      return null;
    }
    return this.getThread(id);
  }

  /**
   * Transitions a thread's coordinator_state via CAS (expected_prev → next).
   * Returns the updated thread, or null when the expected state did not match.
   */
  public transitionCoordinatorState(
    id: string,
    expectedPrev: CoordinatorState,
    next: CoordinatorState
  ): Thread | null {
    const result = this.sqlite
      .prepare(
        `UPDATE threads SET coordinator_state = ?
         WHERE id = ? AND coordinator_state = ?`
      )
      .run(next, id, expectedPrev);
    if (result.changes === 0) {
      return null;
    }
    return this.getThread(id);
  }

  public insertMessage(message: Message): void {
    const senderType = message.sender.type;
    const senderAgentId =
      message.sender.type === "agent" ? message.sender.agentId : null;
    this.db
      .insert(schema.messages)
      .values({
        id: message.id,
        threadId: message.threadId,
        senderType,
        senderAgentId,
        kind: message.kind,
        payload: JSON.stringify(message.payload ?? {}),
        consumedByRunId: message.consumedByRunId ?? null,
        createdAt: message.createdAt
      })
      .run();
  }

  public getMessage(id: string): Message | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, thread_id, sender_type, sender_agent_id, kind, payload,
                consumed_by_run_id, created_at
         FROM messages
         WHERE id = ?
         LIMIT 1`
      )
      .get(id) as
      | {
          id: string;
          thread_id: string;
          sender_type: string;
          sender_agent_id: string | null;
          kind: string;
          payload: string;
          consumed_by_run_id: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) return null;

    return rowToMessage({
      id: row.id,
      threadId: row.thread_id,
      senderType: row.sender_type,
      senderAgentId: row.sender_agent_id,
      kind: row.kind,
      payload: row.payload,
      consumedByRunId: row.consumed_by_run_id,
      createdAt: row.created_at
    } as MessageRow);
  }

  public updateMessagePayload(id: string, payload: unknown): Message | null {
    const result = this.sqlite
      .prepare(`UPDATE messages SET payload = ? WHERE id = ?`)
      .run(JSON.stringify(payload ?? {}), id);
    if (result.changes === 0) {
      return null;
    }
    return this.getMessage(id);
  }

  public listMessages(
    threadId: string,
    opts: { after?: string; limit?: number } = {}
  ): Message[] {
    // Raw SQL keeps the cursor + limit path simple without drizzle op juggling.
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 500));
    if (!opts.after) {
      const rows = this.sqlite
        .prepare(
          `SELECT id, thread_id, sender_type, sender_agent_id, kind, payload,
                  consumed_by_run_id, created_at
           FROM messages
           WHERE thread_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`
        )
        .all(threadId, limit) as Array<{
        id: string;
        thread_id: string;
        sender_type: string;
        sender_agent_id: string | null;
        kind: string;
        payload: string;
        consumed_by_run_id: string | null;
        created_at: string;
      }>;
      return rows.reverse().map((row) =>
        rowToMessage({
          id: row.id,
          threadId: row.thread_id,
          senderType: row.sender_type,
          senderAgentId: row.sender_agent_id,
          kind: row.kind,
          payload: row.payload,
          consumedByRunId: row.consumed_by_run_id,
          createdAt: row.created_at
        } as MessageRow)
      );
    }

    const clauses: string[] = ["thread_id = ?", "created_at > ?"];
    const params: unknown[] = [threadId, opts.after];
    const rows = this.sqlite
      .prepare(
        `SELECT id, thread_id, sender_type, sender_agent_id, kind, payload,
                consumed_by_run_id, created_at
         FROM messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at ASC, rowid ASC
         LIMIT ?`
      )
      .all(...params, limit) as Array<{
      id: string;
      thread_id: string;
      sender_type: string;
      sender_agent_id: string | null;
      kind: string;
      payload: string;
      consumed_by_run_id: string | null;
      created_at: string;
    }>;
    return rows.map((row) =>
      rowToMessage({
        id: row.id,
        threadId: row.thread_id,
        senderType: row.sender_type,
        senderAgentId: row.sender_agent_id,
        kind: row.kind,
        payload: row.payload,
        consumedByRunId: row.consumed_by_run_id,
        createdAt: row.created_at
      } as MessageRow)
    );
  }

  /**
   * Returns user-sent messages on the thread whose `consumed_by_run_id` is NULL.
   * Used by the Orchestrator to flush pending input into the next coordinator run.
   */
  public listPendingCoordinatorMessages(threadId: string): Message[] {
    // Both user chat and injected system_event messages feed the next turn.
    // Agent-authored messages are the coordinator's own output and must not
    // loop back into its input.
    const rows = this.sqlite
      .prepare(
        `SELECT id, thread_id, sender_type, sender_agent_id, kind, payload,
                consumed_by_run_id, created_at
         FROM messages
         WHERE thread_id = ?
           AND consumed_by_run_id IS NULL
           AND (sender_type = 'user' OR kind = 'system_event')
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(threadId) as Array<{
      id: string;
      thread_id: string;
      sender_type: string;
      sender_agent_id: string | null;
      kind: string;
      payload: string;
      consumed_by_run_id: string | null;
      created_at: string;
    }>;
    return rows.map((row) =>
      rowToMessage({
        id: row.id,
        threadId: row.thread_id,
        senderType: row.sender_type,
        senderAgentId: row.sender_agent_id,
        kind: row.kind,
        payload: row.payload,
        consumedByRunId: row.consumed_by_run_id,
        createdAt: row.created_at
      } as MessageRow)
    );
  }

  public markMessagesConsumed(messageIds: string[], runId: string): void {
    if (messageIds.length === 0) {
      return;
    }
    const stmt = this.sqlite.prepare(
      `UPDATE messages SET consumed_by_run_id = ?
       WHERE id = ? AND consumed_by_run_id IS NULL`
    );
    const tx = this.sqlite.transaction((ids: string[]) => {
      for (const id of ids) {
        stmt.run(runId, id);
      }
    });
    tx(messageIds);
  }

  public getAgentSessionByThread(threadId: string): AgentSession | null {
    const row = this.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.threadId, threadId))
      .get();
    return row ? rowToAgentSession(row) : null;
  }

  public insertAgentSession(session: AgentSession): void {
    this.db
      .insert(schema.agentSessions)
      .values({
        id: session.id,
        workspaceId: session.workspaceId,
        agentId: session.agentId,
        threadId: session.threadId,
        runnerSessionKey: session.runnerSessionKey ?? null,
        createdAt: session.createdAt
      })
      .run();
  }

  public deleteAgentSessionByThread(threadId: string): void {
    this.db
      .delete(schema.agentSessions)
      .where(eq(schema.agentSessions.threadId, threadId))
      .run();
  }

  public updateAgentSessionRunnerKey(
    sessionId: string,
    runnerSessionKey: string
  ): AgentSession | null {
    const result = this.sqlite
      .prepare(
        `UPDATE agent_sessions SET runner_session_key = ? WHERE id = ?`
      )
      .run(runnerSessionKey, sessionId);
    if (result.changes === 0) {
      return null;
    }
    const row = this.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId))
      .get();
    return row ? rowToAgentSession(row) : null;
  }

  // ── Plans (agent-driven board) ────────────────────────────────────────────

  public insertPlan(plan: Plan): void {
    this.db
      .insert(schema.plans)
      .values({
        id: plan.id,
        threadId: plan.threadId,
        proposerAgentId: plan.proposerAgentId,
        status: plan.status,
        drafts: JSON.stringify(plan.drafts ?? []),
        approvedAt: plan.approvedAt ?? null,
        createdAt: plan.createdAt
      })
      .run();
  }

  public getPlan(id: string): Plan | null {
    const row = this.db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.id, id))
      .get();
    return row ? rowToPlan(row) : null;
  }

  public listPlansByThread(threadId: string): Plan[] {
    return this.db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.threadId, threadId))
      .orderBy(asc(schema.plans.createdAt))
      .all()
      .map(rowToPlan);
  }

  /**
   * CAS the plan's status. Returns the updated plan when the expected status
   * matched, null otherwise. When `approvedAt` is provided it is stored on the
   * row (only meaningful for 'approved' transitions).
   */
  public casPlanStatus(
    id: string,
    expected: PlanStatus,
    next: PlanStatus,
    approvedAt?: string
  ): Plan | null {
    const stmt =
      approvedAt != null
        ? this.sqlite.prepare(
            `UPDATE plans SET status = ?, approved_at = ?
             WHERE id = ? AND status = ?`
          )
        : this.sqlite.prepare(
            `UPDATE plans SET status = ?
             WHERE id = ? AND status = ?`
          );
    const result =
      approvedAt != null
        ? stmt.run(next, approvedAt, id, expected)
        : stmt.run(next, id, expected);
    if (result.changes === 0) {
      return null;
    }
    return this.getPlan(id);
  }

  /**
   * Raw INSERT for a single task — used by PlanService inside a transaction
   * so the CAS + task inserts + decision message commit atomically. Callers
   * MUST append the task to the in-memory state.tasks cache after commit
   * (see `appendTasksToMemory`), otherwise the next save() will wipe it.
   */
  public insertTaskRaw(task: Task): void {
    const row = taskToRow(task);
    this.sqlite
      .prepare(
        `INSERT INTO tasks (id, title, description, workspace_id, column, task_order, plan, worktree, last_run_id, last_run_status, continuation_run_id, pull_request_url, pull_request, rejected, cancelled_at, task_kind, parent_task_id, source, plan_id, assignee_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.title,
        row.description,
        row.workspaceId,
        row.column,
        row.taskOrder,
        row.plan ?? null,
        row.worktree,
        row.lastRunId ?? null,
        row.lastRunStatus ?? null,
        row.continuationRunId ?? null,
        row.pullRequestUrl ?? null,
        row.pullRequest ?? null,
        row.rejected ? 1 : 0,
        row.cancelledAt ?? null,
        row.taskKind,
        row.parentTaskId ?? null,
        row.source ?? "user",
        row.planId ?? null,
        row.assigneeAgentId ?? null,
        row.createdAt,
        row.updatedAt
      );
    const depStmt = this.sqlite.prepare(
      "INSERT INTO task_dependencies (task_id, dep_id) VALUES (?, ?)"
    );
    for (const depId of task.dependencies) {
      depStmt.run(task.id, depId);
    }
  }

  /**
   * Appends tasks to the in-memory state cache. Call after a DB transaction
   * that inserted tasks via `insertTaskRaw`, so that subsequent `getTasks()`
   * reads and the next `save()` include them.
   */
  public appendTasksToMemory(tasks: Task[]): void {
    if (tasks.length === 0) {
      return;
    }
    this.state.tasks = [...this.state.tasks, ...tasks];
  }

  /**
   * Runs `fn` inside a synchronous SQLite transaction and returns its result.
   * Exposed so services (PlanService) can compose CAS + multi-table writes
   * atomically without pulling in raw better-sqlite3 handles.
   */
  public runInTransaction<T>(fn: () => T): T {
    const tx = this.sqlite.transaction(fn);
    return tx() as T;
  }

  /** Closes the underlying SQLite connection. Call on server shutdown. */
  public close(): void {
    this.sqlite?.close();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Ensures a workspace has at most one coordinator agent. Call before mounting
   * or changing an agent's role to "coordinator".
   * @param excludeAgentId Skip this agent when counting coordinators (for role updates).
   */
  private ensureSingleCoordinator(workspaceId: string, excludeAgentId?: string): void {
    const existing = this.db
      .select()
      .from(schema.workspaceAgents)
      .where(
        and(
          eq(schema.workspaceAgents.workspaceId, workspaceId),
          eq(schema.workspaceAgents.role, "coordinator")
        )
      )
      .all();
    const conflicting = excludeAgentId
      ? existing.filter((wa) => wa.agentId !== excludeAgentId)
      : existing;
    if (conflicting.length > 0) {
      throw new AppError(
        409,
        "COORDINATOR_ALREADY_EXISTS",
        "This workspace already has a coordinator agent"
      );
    }
  }

  private initSchema(): void {
    // v7 -> v8: drop legacy team / channel / proposal tables. Runtime moved to
    // threads / messages / plans (Spec 01). Legacy tables (if present from an
    // older install) are dropped unconditionally — any data worth preserving
    // was migrated during P1-P3 dual-write. After this runs, subsequent loads
    // hit DROP TABLE IF EXISTS as a no-op.
    this.sqlite.exec(`
      DROP TABLE IF EXISTS channel_messages;
      DROP TABLE IF EXISTS task_messages;
      DROP TABLE IF EXISTS workspace_channels;
      DROP TABLE IF EXISTS coordinator_proposals;
      DROP TABLE IF EXISTS team_messages;
      DROP TABLE IF EXISTS teams;
    `);

    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        is_git_repo INTEGER NOT NULL DEFAULT 0,
        codex_settings TEXT NOT NULL,
        prompt_templates TEXT,
        pr_strategy TEXT NOT NULL DEFAULT 'independent',
        auto_approve_subtasks INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL,
        column TEXT NOT NULL,
        task_order REAL NOT NULL,
        plan TEXT,
        worktree TEXT NOT NULL,
        last_run_id TEXT,
        last_run_status TEXT,
        continuation_run_id TEXT,
        pull_request_url TEXT,
        pull_request TEXT,
        rejected INTEGER NOT NULL DEFAULT 0,
        cancelled_at TEXT,
        task_kind TEXT NOT NULL DEFAULT 'user',
        parent_task_id TEXT,
        source TEXT NOT NULL DEFAULT 'user',
        plan_id TEXT,
        assignee_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        dep_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, dep_id)
      );

      CREATE INDEX IF NOT EXISTS idx_task_deps_task_id ON task_dependencies (task_id);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        status TEXT NOT NULL,
        runner_type TEXT NOT NULL,
        command TEXT NOT NULL DEFAULT '',
        pid INTEGER,
        exit_code INTEGER,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        log_file TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs (task_id);

      -- run_log_entries intentionally has no FK to runs: persistState uses a
      -- delete-all + re-insert pattern for runs, so a CASCADE would wipe all
      -- log entries on every save(). Orphaned entries are cleaned up explicitly
      -- at the end of each persistState transaction instead.
      CREATE TABLE IF NOT EXISTS run_log_entries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        stream TEXT NOT NULL,
        kind TEXT NOT NULL,
        entry_text TEXT NOT NULL,
        title TEXT,
        source TEXT,
        metadata TEXT
      );

      -- Composite index supports efficient ORDER BY timestamp queries per run
      CREATE INDEX IF NOT EXISTS idx_run_log_entries_run_id_ts
        ON run_log_entries (run_id, timestamp);

      -- Phase 4: account-level agents + workspace mounting
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        runner_config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_agents (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'worker',
        description TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_agents_workspace_id
        ON workspace_agents (workspace_id);

      -- === Agent-driven board (Spec 01): unified thread/message/plan tables ===

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        task_id TEXT,
        coordinator_agent_id TEXT,
        coordinator_state TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_threads_workspace_kind
        ON threads (workspace_id, kind);
      CREATE INDEX IF NOT EXISTS idx_threads_task_id ON threads (task_id);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        sender_type TEXT NOT NULL,
        sender_agent_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        consumed_by_run_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_thread_created_at
        ON messages (thread_id, created_at);
      -- Partial index supports the "pending to consume" query (user messages
      -- waiting for the next coordinator run).
      CREATE INDEX IF NOT EXISTS idx_messages_thread_pending
        ON messages (thread_id) WHERE consumed_by_run_id IS NULL;

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        proposer_agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        drafts TEXT NOT NULL,
        approved_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_plans_thread_status
        ON plans (thread_id, status);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
        runner_session_key TEXT,
        created_at TEXT NOT NULL
      );
    `);

    // Idempotent column backfill for upgrades from v7 databases that already
    // have the tasks / workspaces tables but lack the agent-driven-board
    // provenance / config columns. SQLite does not support IF NOT EXISTS on
    // ALTER TABLE ADD COLUMN, so we use try/catch.
    for (const col of [
      "ALTER TABLE tasks ADD COLUMN last_run_status TEXT",
      "ALTER TABLE tasks ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN cancelled_at TEXT",
      "ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'user'",
      "ALTER TABLE tasks ADD COLUMN parent_task_id TEXT",
      "ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'user'",
      "ALTER TABLE tasks ADD COLUMN plan_id TEXT",
      "ALTER TABLE tasks ADD COLUMN assignee_agent_id TEXT",
      "ALTER TABLE workspaces ADD COLUMN pr_strategy TEXT NOT NULL DEFAULT 'independent'",
      "ALTER TABLE workspaces ADD COLUMN auto_approve_subtasks INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE workspace_agents ADD COLUMN description TEXT"
    ]) {
      try {
        this.sqlite.exec(col);
      } catch {
        // column already exists — safe to ignore
      }
    }

    // v7 -> v8: drop legacy columns from the tasks table. SQLite 3.35+ supports
    // ALTER TABLE DROP COLUMN. If the columns are absent (fresh install) the
    // statements fail silently via try/catch.
    for (const drop of [
      "ALTER TABLE tasks DROP COLUMN team_id",
      "ALTER TABLE tasks DROP COLUMN team_agent_id",
      "ALTER TABLE tasks DROP COLUMN runner_type",
      "ALTER TABLE tasks DROP COLUMN runner_config"
    ]) {
      try {
        this.sqlite.exec(drop);
      } catch {
        // column already absent — safe to ignore
      }
    }

    this.sqlite.exec(`
      UPDATE tasks
      SET column = 'todo', updated_at = datetime('now')
      WHERE column = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM runs
          WHERE runs.task_id = tasks.id
            AND runs.status IN ('queued', 'running')
        );
    `);
  }


  private readStateFromDb(): AppState {
    const settingsRow = this.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, SETTINGS_KEY))
      .get();
    const globalSettings = settingsRow
      ? resolveGlobalSettings(JSON.parse(settingsRow.value) as GlobalSettings)
      : resolveGlobalSettings(undefined);

    const workspaceRows = this.db.select().from(schema.workspaces).all();
    const workspaceList = workspaceRows.map(rowToWorkspace);

    const taskRows = this.db.select().from(schema.tasks).all();
    const depRows = this.db.select().from(schema.taskDependencies).all();
    const depsByTaskId = new Map<string, string[]>();
    for (const dep of depRows) {
      let arr = depsByTaskId.get(dep.taskId);
      if (!arr) {
        arr = [];
        depsByTaskId.set(dep.taskId, arr);
      }
      arr.push(dep.depId);
    }
    const taskList = taskRows.map((row) => rowToTask(row, depsByTaskId.get(row.id) ?? []));

    const runRows = this.db.select().from(schema.runs).all();
    const runList = runRows.map(rowToRun);

    return {
      schemaVersion: 9,
      settings: globalSettings,
      workspaces: workspaceList,
      tasks: taskList,
      runs: runList
    };
  }

  // TODO(tech-debt): replace delete-all + re-insert with incremental upsert to
  // avoid write amplification on large datasets (W1 from Architect review).
  // Raw SQL is intentionally used here (rather than Drizzle builder) because
  // better-sqlite3 transactions require synchronous statements and the raw
  // prepare/run pattern is simpler and faster for bulk operations.
  private persistState(state: AppState): void {
    const persist = this.sqlite.transaction(() => {
      // Defer FK constraint checks until COMMIT so the delete-all + re-insert
      // pattern doesn't produce intermediate FK violations.
      this.sqlite.prepare("PRAGMA defer_foreign_keys = ON").run();

      // Settings
      this.sqlite
        .prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(SETTINGS_KEY, JSON.stringify(state.settings));

      // Workspaces: incremental upsert so direct-DB tables keyed by workspace_id
      // (workspace_agents, channels, proposals) are not wiped on every save.
      if (state.workspaces.length === 0) {
        this.sqlite.prepare("DELETE FROM workspaces").run();
      } else {
        const placeholders = state.workspaces.map(() => "?").join(", ");
        this.sqlite
          .prepare(`DELETE FROM workspaces WHERE id NOT IN (${placeholders})`)
          .run(...state.workspaces.map((workspace) => workspace.id));
      }

      for (const ws of state.workspaces) {
        const row = workspaceToRow(ws);
        this.sqlite
          .prepare(
            `INSERT INTO workspaces (id, name, root_path, is_git_repo, codex_settings, prompt_templates, pr_strategy, auto_approve_subtasks, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               root_path = excluded.root_path,
               is_git_repo = excluded.is_git_repo,
               codex_settings = excluded.codex_settings,
               prompt_templates = excluded.prompt_templates,
               pr_strategy = excluded.pr_strategy,
               auto_approve_subtasks = excluded.auto_approve_subtasks,
               updated_at = excluded.updated_at`
          )
          .run(
            row.id,
            row.name,
            row.rootPath,
            row.isGitRepo ? 1 : 0,
            row.codexSettings,
            row.promptTemplates ?? null,
            row.prStrategy ?? "independent",
            row.autoApproveSubtasks ? 1 : 0,
            row.createdAt,
            row.updatedAt
          );
      }

      // Runs: delete before tasks because runs.task_id REFERENCES tasks(id).
      // With defer_foreign_keys this ordering is not strictly required, but it
      // makes the intent explicit.
      this.sqlite.prepare("DELETE FROM runs").run();

      // Tasks: delete cascades to task_dependencies via FK ON DELETE CASCADE.
      this.sqlite.prepare("DELETE FROM tasks").run();
      for (const task of state.tasks) {
        const row = taskToRow(task);
        this.sqlite
          .prepare(
            `INSERT INTO tasks (id, title, description, workspace_id, column, task_order, plan, worktree, last_run_id, last_run_status, continuation_run_id, pull_request_url, pull_request, rejected, cancelled_at, task_kind, parent_task_id, source, plan_id, assignee_agent_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            row.id,
            row.title,
            row.description,
            row.workspaceId,
            row.column,
            row.taskOrder,
            row.plan ?? null,
            row.worktree,
            row.lastRunId ?? null,
            row.lastRunStatus ?? null,
            row.continuationRunId ?? null,
            row.pullRequestUrl ?? null,
            row.pullRequest ?? null,
            row.rejected ? 1 : 0,
            row.cancelledAt ?? null,
            row.taskKind,
            row.parentTaskId ?? null,
            row.source ?? "user",
            row.planId ?? null,
            row.assigneeAgentId ?? null,
            row.createdAt,
            row.updatedAt
          );
        for (const depId of task.dependencies) {
          this.sqlite
            .prepare(
              "INSERT INTO task_dependencies (task_id, dep_id) VALUES (?, ?)"
            )
            .run(task.id, depId);
        }
      }

      // Re-insert all current runs (tasks exist at this point).
      for (const run of state.runs) {
        const row = runToRow(run);
        this.sqlite
          .prepare(
            `INSERT INTO runs (id, task_id, status, runner_type, command, pid, exit_code, started_at, ended_at, log_file, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            row.id,
            row.taskId,
            row.status,
            row.runnerType,
            row.command,
            row.pid ?? null,
            row.exitCode ?? null,
            row.startedAt,
            row.endedAt ?? null,
            row.logFile ?? null,
            row.metadata ?? null
          );
      }

      // Clean up orphaned log entries for runs that are no longer in state.
      // run_log_entries has no FK CASCADE (see DDL comment), so we handle
      // cleanup explicitly here.
      this.sqlite
        .prepare("DELETE FROM run_log_entries WHERE run_id NOT IN (SELECT id FROM runs)")
        .run();
    });

    persist();
  }

  private async withWriteLock<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.writeBarrier;
    let release: (() => void) | undefined;
    this.writeBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await work();
    } finally {
      release?.();
    }
  }

  // -------------------------------------------------------------------------
  // JSON → SQLite migration
  // -------------------------------------------------------------------------

  private async detectJsonMigration(): Promise<boolean> {
    try {
      await access(this.stateFile, constants.F_OK);
    } catch {
      return false;
    }

    // state.json exists — check if we already have data in SQLite
    const hasSettings = this.sqlite
      .prepare("SELECT 1 FROM settings WHERE key = ? LIMIT 1")
      .get(SETTINGS_KEY);
    return !hasSettings;
  }

  private async runJsonMigration(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.stateFile, "utf8");
    } catch {
      return;
    }

    const jsonState = sanitizeStateForPersistence(
      migrateJsonState(JSON.parse(raw) as AppState)
    );

    // Migrate per-run NDJSON log files
    const logEntries = await this.collectLegacyLogEntries(jsonState.runs);

    // Write everything in one transaction
    const migrate = this.sqlite.transaction(() => {
      this.persistState(jsonState);

      for (const entry of logEntries) {
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO run_log_entries (id, run_id, timestamp, stream, kind, entry_text, title, source, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            entry.id,
            entry.runId,
            entry.timestamp,
            entry.stream,
            entry.kind,
            entry.text,
            entry.title ?? null,
            entry.source ?? null,
            entry.metadata != null ? JSON.stringify(entry.metadata) : null
          );
      }
    });

    migrate();

    // Back up old files
    try {
      await rename(this.stateFile, `${this.stateFile}.backup`);
    } catch {
      // Best-effort backup
    }
    try {
      await rename(this.logsDir, `${this.logsDir}.backup`);
    } catch {
      // Best-effort backup
    }
  }

  private async collectLegacyLogEntries(runs: Run[]): Promise<RunLogEntry[]> {
    const entries: RunLogEntry[] = [];
    for (const run of runs) {
      if (!run.logFile) continue;
      try {
        const raw = await readFile(run.logFile, "utf8");
        const parsed = parseRunLogEntries(run.id, raw);
        entries.push(...parsed);
      } catch {
        // Log file may not exist — skip
      }
    }
    return entries;
  }
}
