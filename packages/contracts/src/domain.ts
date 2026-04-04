export type TaskColumn =
  | "backlog"
  | "todo"
  | "running"
  | "review"
  | "done"
  | "archived";

export type RunnerType = "claude" | "codex" | "shell";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "canceled";

export type RunLogStream = "stdout" | "stderr" | "system";

export type RunLogKind =
  | "text"
  | "user"
  | "agent"
  | "tool_call"
  | "tool_output"
  | "plan"
  | "system"
  | "status";

export type TaskWorktreeStatus =
  | "not_created"
  | "ready"
  | "cleanup_pending"
  | "removed";

export interface TaskWorktree {
  baseRef: string;
  branchName: string;
  path?: string;
  status: TaskWorktreeStatus;
  cleanupReason?: string;
  lastSyncedBaseAt?: string;
}

export interface TaskPullRequestChecks {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped?: number;
}

export interface TaskPullRequestFile {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface TaskPullRequest {
  number?: number;
  title?: string;
  state?: string;
  isDraft?: boolean;
  changedFiles?: number;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollupState?: string;
  threadCount?: number;
  unresolvedConversationCount?: number;
  reviewCount?: number;
  approvalCount?: number;
  changesRequestedCount?: number;
  checks?: TaskPullRequestChecks;
  statusChecks?: TaskPullRequestChecks;
  files?: TaskPullRequestFile[];
}

export type WorkspaceGitRefKind = "remote" | "local";

export interface WorkspaceGitRef {
  name: string;
  kind: WorkspaceGitRefKind;
  isDefault: boolean;
}

export type CodexApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export interface WorkspaceCodexSettings {
  approvalPolicy: CodexApprovalPolicy;
  sandboxMode: CodexSandboxMode;
}

export const DEFAULT_GLOBAL_LANGUAGE = "中文";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterSettings {
  baseUrl: string;
  token: string;
  model: string;
}

export interface GlobalSettings {
  language: string;
  openRouter: OpenRouterSettings;
}

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  isGitRepo: boolean;
  codexSettings: WorkspaceCodexSettings;
  createdAt: string;
  updatedAt: string;
}

export interface ShellRunnerConfig {
  type: "shell";
  command: string;
}

export type ClaudePermissionMode =
  | "acceptEdits"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export interface ClaudeRunnerConfig {
  type: "claude";
  prompt: string;
  agent?: string;
  model?: string;
  permissionMode?: ClaudePermissionMode;
}

export interface CodexRunnerConfig {
  type: "codex";
  prompt: string;
  model?: string;
  approvalMode?: "default" | "auto";
}

export type RunnerConfig = ShellRunnerConfig | ClaudeRunnerConfig | CodexRunnerConfig;

export interface Task {
  id: string;
  title: string;
  description: string;
  workspaceId: string;
  column: TaskColumn;
  order: number;
  runnerType: RunnerType;
  runnerConfig: RunnerConfig;
  plan?: string;
  worktree: TaskWorktree;
  lastRunId?: string;
  continuationRunId?: string;
  pullRequestUrl?: string;
  pullRequest?: TaskPullRequest;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  runnerType: RunnerType;
  command: string;
  pid?: number;
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
  logFile: string;
  metadata?: Record<string, string>;
}

export interface RunLogEntry {
  id: string;
  runId: string;
  timestamp: string;
  stream: RunLogStream;
  kind: RunLogKind;
  text: string;
  title?: string;
  source?: string;
  metadata?: Record<string, string>;
}

export interface AppState {
  schemaVersion: number;
  settings: GlobalSettings;
  workspaces: Workspace[];
  tasks: Task[];
  runs: Run[];
}
