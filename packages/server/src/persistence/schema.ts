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
  runnerType: text("runner_type").notNull(),
  runnerConfig: text("runner_config").notNull(),
  plan: text("plan"),
  worktree: text("worktree").notNull(),
  lastRunId: text("last_run_id"),
  continuationRunId: text("continuation_run_id"),
  pullRequestUrl: text("pull_request_url"),
  pullRequest: text("pull_request"),
  teamId: text("team_id"),
  parentTaskId: text("parent_task_id"),
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

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  workspaceId: text("workspace_id").notNull(),
  agents: text("agents").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const teamMessages = sqliteTable("team_messages", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  taskId: text("task_id"),
  agentName: text("agent_name").notNull(),
  direction: text("direction").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull()
});
