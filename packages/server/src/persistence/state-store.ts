import { access, mkdir, readFile, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, asc, eq } from "drizzle-orm";

import type {
  AccountAgent,
  AgentRole,
  AgentTeam,
  AppState,
  CoordinatorProposal,
  CoordinatorProposalDraft,
  CoordinatorProposalStatus,
  GlobalSettings,
  Run,
  RunLogEntry,
  RunnerConfig,
  Task,
  TaskMessage,
  TeamMessage,
  TeamPrStrategy,
  Workspace,
  WorkspaceAgent
} from "@workhorse/contracts";

import { parseRunLogEntries } from "../lib/run-log.js";
import { resolveWorkspaceCodexSettings } from "../lib/codex-settings.js";
import { AppError } from "../lib/errors.js";
import { resolveGlobalSettings } from "../lib/global-settings.js";
import { createTaskWorktree } from "../lib/task-worktree.js";
import { resolveWorkspacePromptTemplates } from "../lib/workspace-prompt-templates.js";
import * as schema from "./schema.js";

const SETTINGS_KEY = "global";

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
        ? (task as Task)
        : (() => {
            const workspace = workspaceById.get(task.workspaceId);
            return {
              ...task,
              worktree: createTaskWorktree(task.id, task.title, { workspace })
            } as Task;
          })();

    if (!Array.isArray(withWorktree.dependencies)) {
      return { ...withWorktree, dependencies: [] } satisfies Task;
    }
    return withWorktree;
  });

  return {
    schemaVersion: state.schemaVersion ?? 6,
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
type TeamRow = typeof schema.teams.$inferSelect;
type TeamMessageRow = typeof schema.teamMessages.$inferSelect;
type AgentRow = typeof schema.agents.$inferSelect;
type WorkspaceAgentRow = typeof schema.workspaceAgents.$inferSelect;
type TaskMessageRow = typeof schema.taskMessages.$inferSelect;

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    isGitRepo: Boolean(row.isGitRepo),
    codexSettings: JSON.parse(row.codexSettings),
    promptTemplates: row.promptTemplates ? JSON.parse(row.promptTemplates) : undefined,
    prStrategy: (row.prStrategy as TeamPrStrategy) ?? undefined,
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
    return raw as RunnerConfig;
  }

  const config = raw as Record<string, unknown>;

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
    role: waRow.role as AgentRole
  };
}

function rowToTaskMessage(row: TaskMessageRow): TaskMessage {
  return {
    id: row.id,
    parentTaskId: row.parentTaskId,
    taskId: row.taskId ?? undefined,
    agentName: row.agentName,
    senderType: row.senderType as TaskMessage["senderType"],
    messageType: row.messageType as TaskMessage["messageType"],
    content: row.content,
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
    runnerType: row.runnerType as Task["runnerType"],
    runnerConfig: normalizeRunnerConfig(JSON.parse(row.runnerConfig)),
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
    teamId: row.teamId ?? undefined,
    parentTaskId: row.parentTaskId ?? undefined,
    teamAgentId: row.teamAgentId ?? undefined,
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
    runnerType: task.runnerType,
    runnerConfig: JSON.stringify(task.runnerConfig),
    plan: task.plan ?? null,
    worktree: JSON.stringify(task.worktree),
    lastRunId: task.lastRunId ?? null,
    lastRunStatus: task.lastRunStatus ?? null,
    continuationRunId: task.continuationRunId ?? null,
    pullRequestUrl: task.pullRequestUrl ?? null,
    pullRequest: task.pullRequest != null ? JSON.stringify(task.pullRequest) : null,
    rejected: task.rejected ?? false,
    cancelledAt: task.cancelledAt ?? null,
    teamId: task.teamId ?? null,
    parentTaskId: task.parentTaskId ?? null,
    teamAgentId: task.teamAgentId ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function rowToTeam(row: TeamRow): AgentTeam {
  const rawAgents = JSON.parse(row.agents) as AgentTeam["agents"];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    workspaceId: row.workspaceId,
    agents: rawAgents.map((teamAgent) => ({
      ...teamAgent,
      runnerConfig: normalizeRunnerConfig(teamAgent.runnerConfig)
    })),
    prStrategy: row.prStrategy as AgentTeam["prStrategy"],
    autoApproveSubtasks: row.autoApproveSubtasks,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function rowToTeamMessage(row: TeamMessageRow): TeamMessage {
  return {
    id: row.id,
    teamId: row.teamId,
    parentTaskId: row.parentTaskId,
    taskId: row.taskId ?? undefined,
    agentName: row.agentName,
    senderType: row.senderType as TeamMessage["senderType"],
    messageType: row.messageType as TeamMessage["messageType"],
    content: row.content,
    createdAt: row.createdAt
  };
}

type ProposalRow = typeof schema.coordinatorProposals.$inferSelect;

function rowToProposal(row: ProposalRow): CoordinatorProposal {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId ?? undefined,
    parentTaskId: row.parentTaskId,
    status: row.status as CoordinatorProposalStatus,
    drafts: JSON.parse(row.drafts) as CoordinatorProposalDraft[],
    createdAt: row.createdAt,
    decidedAt: row.decidedAt ?? undefined
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
    schemaVersion: 6,
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
  // Team CRUD (go directly to SQLite, not buffered in AppState)
  // -------------------------------------------------------------------------

  public listTeams(workspaceId?: string): AgentTeam[] {
    const query = this.db.select().from(schema.teams);
    const rows = workspaceId
      ? query.where(eq(schema.teams.workspaceId, workspaceId)).all()
      : query.all();
    return rows.map(rowToTeam);
  }

  public getTeam(teamId: string): AgentTeam | null {
    const row = this.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId))
      .get();
    return row ? rowToTeam(row) : null;
  }

  public createTeam(team: AgentTeam): AgentTeam {
    this.db
      .insert(schema.teams)
      .values({
        id: team.id,
        name: team.name,
        description: team.description,
        workspaceId: team.workspaceId,
        agents: JSON.stringify(team.agents),
        prStrategy: team.prStrategy,
        autoApproveSubtasks: team.autoApproveSubtasks,
        createdAt: team.createdAt,
        updatedAt: team.updatedAt
      })
      .run();
    return team;
  }

  public updateTeam(teamId: string, updates: Partial<Pick<AgentTeam, "name" | "description" | "agents" | "prStrategy" | "autoApproveSubtasks">>): AgentTeam | null {
    const existing = this.getTeam(teamId);
    if (!existing) {
      return null;
    }
    const updated: AgentTeam = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    this.db
      .update(schema.teams)
      .set({
        name: updated.name,
        description: updated.description,
        agents: JSON.stringify(updated.agents),
        prStrategy: updated.prStrategy,
        autoApproveSubtasks: updated.autoApproveSubtasks,
        updatedAt: updated.updatedAt
      })
      .where(eq(schema.teams.id, teamId))
      .run();
    return updated;
  }

  public deleteTeam(teamId: string): boolean {
    const result = this.db
      .delete(schema.teams)
      .where(eq(schema.teams.id, teamId))
      .run();
    return result.changes > 0;
  }

  public listTeamMessages(teamId: string, parentTaskId?: string): TeamMessage[] {
    const rows = parentTaskId
      ? this.db
          .select()
          .from(schema.teamMessages)
          .where(
            and(
              eq(schema.teamMessages.teamId, teamId),
              eq(schema.teamMessages.parentTaskId, parentTaskId)
            )
          )
          .orderBy(asc(schema.teamMessages.createdAt))
          .all()
      : this.db
          .select()
          .from(schema.teamMessages)
          .where(eq(schema.teamMessages.teamId, teamId))
          .orderBy(asc(schema.teamMessages.createdAt))
          .all();
    return rows.map(rowToTeamMessage);
  }

  public appendTeamMessage(message: TeamMessage): void {
    const MAX_CONTENT_BYTES = 10 * 1024;
    if (Buffer.byteLength(message.content, "utf8") > MAX_CONTENT_BYTES) {
      throw new AppError(400, "MESSAGE_TOO_LARGE", "Message content exceeds 10KB limit");
    }
    this.db
      .insert(schema.teamMessages)
      .values({
        id: message.id,
        teamId: message.teamId,
        parentTaskId: message.parentTaskId,
        taskId: message.taskId ?? null,
        agentName: message.agentName,
        senderType: message.senderType,
        messageType: message.messageType,
        content: message.content,
        createdAt: message.createdAt
      })
      .run();
  }

  // -------------------------------------------------------------------------
  // Coordinator Proposals (go directly to SQLite, not buffered in AppState)
  // -------------------------------------------------------------------------

  public listProposals(teamId: string, parentTaskId?: string): CoordinatorProposal[] {
    const rows = parentTaskId
      ? this.db
          .select()
          .from(schema.coordinatorProposals)
          .where(
            and(
              eq(schema.coordinatorProposals.teamId, teamId),
              eq(schema.coordinatorProposals.parentTaskId, parentTaskId)
            )
          )
          .orderBy(asc(schema.coordinatorProposals.createdAt))
          .all()
      : this.db
          .select()
          .from(schema.coordinatorProposals)
          .where(eq(schema.coordinatorProposals.teamId, teamId))
          .orderBy(asc(schema.coordinatorProposals.createdAt))
          .all();
    return rows.map(rowToProposal);
  }

  public listProposalsByWorkspace(
    workspaceId: string,
    parentTaskId?: string
  ): CoordinatorProposal[] {
    const rows = parentTaskId
      ? this.db
          .select()
          .from(schema.coordinatorProposals)
          .where(
            and(
              eq(schema.coordinatorProposals.workspaceId, workspaceId),
              eq(schema.coordinatorProposals.parentTaskId, parentTaskId)
            )
          )
          .orderBy(asc(schema.coordinatorProposals.createdAt))
          .all()
      : this.db
          .select()
          .from(schema.coordinatorProposals)
          .where(eq(schema.coordinatorProposals.workspaceId, workspaceId))
          .orderBy(asc(schema.coordinatorProposals.createdAt))
          .all();
    return rows.map(rowToProposal);
  }

  public getProposal(proposalId: string): CoordinatorProposal | null {
    const row = this.db
      .select()
      .from(schema.coordinatorProposals)
      .where(eq(schema.coordinatorProposals.id, proposalId))
      .get();
    return row ? rowToProposal(row) : null;
  }

  public saveProposal(proposal: CoordinatorProposal): CoordinatorProposal {
    this.db
      .insert(schema.coordinatorProposals)
      .values({
        id: proposal.id,
        teamId: proposal.teamId,
        workspaceId: proposal.workspaceId ?? null,
        parentTaskId: proposal.parentTaskId,
        status: proposal.status,
        drafts: JSON.stringify(proposal.drafts),
        createdAt: proposal.createdAt,
        decidedAt: proposal.decidedAt ?? null
      })
      .run();
    return proposal;
  }

  public updateProposalStatus(
    proposalId: string,
    status: CoordinatorProposalStatus,
    decidedAt: string | null
  ): CoordinatorProposal | null {
    const existing = this.getProposal(proposalId);
    if (!existing) {
      return null;
    }
    this.db
      .update(schema.coordinatorProposals)
      .set({ status, decidedAt })
      .where(eq(schema.coordinatorProposals.id, proposalId))
      .run();
    return { ...existing, status, decidedAt: decidedAt ?? undefined };
  }

  /**
   * Compare-and-swap: updates status from `expectedStatus` to `newStatus` atomically.
   * Returns the updated proposal on success, or null if the status did not match
   * (i.e., a concurrent caller already changed it).
   */
  public updateProposalStatusCAS(
    proposalId: string,
    expectedStatus: CoordinatorProposalStatus,
    newStatus: CoordinatorProposalStatus,
    decidedAt: string
  ): CoordinatorProposal | null {
    const existing = this.getProposal(proposalId);
    if (!existing) {
      return null;
    }
    const result = this.db
      .update(schema.coordinatorProposals)
      .set({ status: newStatus, decidedAt })
      .where(
        and(
          eq(schema.coordinatorProposals.id, proposalId),
          eq(schema.coordinatorProposals.status, expectedStatus)
        )
      )
      .run();
    if (result.changes === 0) {
      return null;
    }
    return { ...existing, status: newStatus, decidedAt };
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
    role: AgentRole
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
      this.db
        .insert(schema.workspaceAgents)
        .values({ workspaceId, agentId, role, createdAt: now })
        .run();
      return { ...agent, role };
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
    return this.sqlite.transaction(() => {
      if (role === "coordinator") {
        this.ensureSingleCoordinator(workspaceId, agentId);
      }
      const result = this.db
        .update(schema.workspaceAgents)
        .set({ role })
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
  // Task Messages (Phase 4 — workspace-level, no team_id)
  // -------------------------------------------------------------------------

  public listTaskMessages(parentTaskId: string): TaskMessage[] {
    return this.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.parentTaskId, parentTaskId))
      .orderBy(asc(schema.taskMessages.createdAt))
      .all()
      .map(rowToTaskMessage);
  }

  public appendTaskMessage(message: TaskMessage): void {
    const MAX_CONTENT_BYTES = 10 * 1024;
    if (Buffer.byteLength(message.content, "utf8") > MAX_CONTENT_BYTES) {
      throw new AppError(400, "MESSAGE_TOO_LARGE", "Message content exceeds 10KB limit");
    }
    this.db
      .insert(schema.taskMessages)
      .values({
        id: message.id,
        parentTaskId: message.parentTaskId,
        taskId: message.taskId ?? null,
        agentName: message.agentName,
        senderType: message.senderType,
        messageType: message.messageType,
        content: message.content,
        createdAt: message.createdAt
      })
      .run();
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
        runner_type TEXT NOT NULL,
        runner_config TEXT NOT NULL,
        plan TEXT,
        worktree TEXT NOT NULL,
        last_run_id TEXT,
        last_run_status TEXT,
        continuation_run_id TEXT,
        pull_request_url TEXT,
        pull_request TEXT,
        rejected INTEGER NOT NULL DEFAULT 0,
        cancelled_at TEXT,
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

      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL,
        agents TEXT NOT NULL,
        pr_strategy TEXT NOT NULL DEFAULT 'independent',
        auto_approve_subtasks INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_teams_workspace_id ON teams (workspace_id);

      CREATE TABLE IF NOT EXISTS team_messages (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        parent_task_id TEXT NOT NULL,
        task_id TEXT,
        agent_name TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_team_messages_team_id ON team_messages (team_id);
      CREATE INDEX IF NOT EXISTS idx_team_messages_team_parent_created_at
        ON team_messages (team_id, parent_task_id, created_at);

      -- team_id is nullable: Phase 4 workspace-scoped proposals set team_id=null
      -- and workspace_id instead. team-scoped proposals (legacy) keep team_id set.
      CREATE TABLE IF NOT EXISTS coordinator_proposals (
        id TEXT PRIMARY KEY,
        team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
        parent_task_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        drafts TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_coordinator_proposals_parent_task_id
        ON coordinator_proposals (team_id, parent_task_id);

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
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_agents_workspace_id
        ON workspace_agents (workspace_id);

      -- task_messages: workspace-level agent communication thread (no team_id).
      -- This table is the long-term replacement for team_messages. The old
      -- team_messages table is intentionally kept intact in this PR; the
      -- create+copy+drop migration (dropping team_id) will happen in PR-E
      -- once all service-layer consumers have been migrated off team_messages.
      CREATE TABLE IF NOT EXISTS task_messages (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT NOT NULL,
        task_id TEXT,
        agent_name TEXT NOT NULL,
        sender_type TEXT NOT NULL DEFAULT 'agent',
        message_type TEXT NOT NULL DEFAULT 'context',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_messages_parent_task_id
        ON task_messages (parent_task_id, created_at);
    `);

    // Add new columns to existing tables. SQLite does not support IF NOT EXISTS
    // on ALTER TABLE ADD COLUMN, so we use try/catch for idempotency.
    for (const col of [
      "ALTER TABLE tasks ADD COLUMN team_id TEXT",
      "ALTER TABLE tasks ADD COLUMN parent_task_id TEXT",
      "ALTER TABLE tasks ADD COLUMN team_agent_id TEXT",
      "ALTER TABLE tasks ADD COLUMN last_run_status TEXT",
      "ALTER TABLE tasks ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN cancelled_at TEXT",
      // v1 -> v2 migration for team execution threads
      "ALTER TABLE team_messages ADD COLUMN parent_task_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE teams ADD COLUMN pr_strategy TEXT NOT NULL DEFAULT 'independent'",
      "ALTER TABLE teams ADD COLUMN auto_approve_subtasks INTEGER NOT NULL DEFAULT 0",
      // Renamed from direction; default 'agent' covers rows written by the initial PR version
      "ALTER TABLE team_messages ADD COLUMN sender_type TEXT NOT NULL DEFAULT 'agent'",
      "ALTER TABLE team_messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'context'",
      // Phase 4: workspace coordination config
      "ALTER TABLE workspaces ADD COLUMN pr_strategy TEXT NOT NULL DEFAULT 'independent'",
      "ALTER TABLE workspaces ADD COLUMN auto_approve_subtasks INTEGER NOT NULL DEFAULT 0",
      // Phase 4: workspace-scoped coordinator proposals
      "ALTER TABLE coordinator_proposals ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE"
    ]) {
      try {
        this.sqlite.exec(col);
      } catch {
        // column already exists — safe to ignore
      }
    }

    // Phase 4: team_id on coordinator_proposals is now nullable (workspace-scoped proposals
    // leave team_id as null). The column cannot be altered directly in SQLite, so we handle
    // this at the application layer by allowing null reads.
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
      schemaVersion: 6,
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

      // Workspaces: replace all
      this.sqlite.prepare("DELETE FROM workspaces").run();
      for (const ws of state.workspaces) {
        const row = workspaceToRow(ws);
        this.sqlite
          .prepare(
            `INSERT INTO workspaces (id, name, root_path, is_git_repo, codex_settings, prompt_templates, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            row.id,
            row.name,
            row.rootPath,
            row.isGitRepo ? 1 : 0,
            row.codexSettings,
            row.promptTemplates ?? null,
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
            `INSERT INTO tasks (id, title, description, workspace_id, column, task_order, runner_type, runner_config, plan, worktree, last_run_id, last_run_status, continuation_run_id, pull_request_url, pull_request, rejected, cancelled_at, team_id, parent_task_id, team_agent_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            row.id,
            row.title,
            row.description,
            row.workspaceId,
            row.column,
            row.taskOrder,
            row.runnerType,
            row.runnerConfig,
            row.plan ?? null,
            row.worktree,
            row.lastRunId ?? null,
            row.lastRunStatus ?? null,
            row.continuationRunId ?? null,
            row.pullRequestUrl ?? null,
            row.pullRequest ?? null,
            row.rejected ? 1 : 0,
            row.cancelledAt ?? null,
            row.teamId ?? null,
            row.parentTaskId ?? null,
            row.teamAgentId ?? null,
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
