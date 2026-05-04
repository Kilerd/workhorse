import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  isGitRepo: integer("is_git_repo", { mode: "boolean" }).notNull().default(false),
  codexSettings: text("codex_settings").notNull(),
  promptTemplates: text("prompt_templates"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  workspaceId: text("workspace_id").notNull(),
  column: text("column").notNull(),
  taskOrder: real("task_order").notNull(),
  plan: text("plan"),
  worktree: text("worktree").notNull(),
  lastRunId: text("last_run_id"),
  lastRunStatus: text("last_run_status"),
  continuationRunId: text("continuation_run_id"),
  pullRequestUrl: text("pull_request_url"),
  pullRequest: text("pull_request"),
  rejected: integer("rejected", { mode: "boolean" }).notNull().default(false),
  cancelledAt: text("cancelled_at"),
  taskKind: text("task_kind").notNull().default("user"),
  parentTaskId: text("parent_task_id"),
  // Agent-driven board (Spec 01): task provenance fields.
  source: text("source").notNull().default("user"),
  planId: text("plan_id"),
  assigneeAgentId: text("assignee_agent_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    depId: text("dep_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" })
  },
  (table) => [primaryKey({ columns: [table.taskId, table.depId] })]
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  status: text("status").notNull(),
  runnerType: text("runner_type").notNull(),
  command: text("command").notNull().default(""),
  pid: integer("pid"),
  exitCode: integer("exit_code"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  logFile: text("log_file"),
  metadata: text("metadata")
});

// run_log_entries intentionally has no FK reference to runs: persistState uses
// delete-all + re-insert for runs, so a CASCADE would wipe all log entries on
// every save(). Orphaned entries are cleaned up explicitly in persistState instead.
export const runLogEntries = sqliteTable("run_log_entries", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  timestamp: text("timestamp").notNull(),
  stream: text("stream").notNull(),
  kind: text("kind").notNull(),
  entryText: text("entry_text").notNull(),
  title: text("title"),
  source: text("source"),
  metadata: text("metadata")
});

// === New agent model (Phase 4 refactor) ===

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  runnerConfig: text("runner_config").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const workspaceAgents = sqliteTable(
  "workspace_agents",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("worker"),
    description: text("description"),
    createdAt: text("created_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.agentId] })]
);

// === Agent-driven board (Spec 01) ===

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  taskId: text("task_id"),
  coordinatorAgentId: text("coordinator_agent_id"),
  coordinatorState: text("coordinator_state").notNull().default("idle"),
  createdAt: text("created_at").notNull(),
  archivedAt: text("archived_at")
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  senderType: text("sender_type").notNull(),
  senderAgentId: text("sender_agent_id"),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  consumedByRunId: text("consumed_by_run_id"),
  createdAt: text("created_at").notNull()
});

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  proposerAgentId: text("proposer_agent_id").notNull(),
  status: text("status").notNull().default("pending"),
  drafts: text("drafts").notNull(),
  approvedAt: text("approved_at"),
  createdAt: text("created_at").notNull()
});

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  threadId: text("thread_id")
    .notNull()
    .unique()
    .references(() => threads.id, { onDelete: "cascade" }),
  runnerSessionKey: text("runner_session_key"),
  createdAt: text("created_at").notNull()
});
