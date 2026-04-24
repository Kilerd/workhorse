export type TaskColumn =
  | "backlog"
  | "todo"
  | "blocked"
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

export type WorkspacePromptTemplateId =
  | "plan"
  | "coding"
  | "review"
  | "reviewFollowUp";

export interface WorkspacePromptTemplates {
  plan?: string;
  coding?: string;
  review?: string;
  reviewFollowUp?: string;
}

export const DEFAULT_GLOBAL_LANGUAGE = "中文";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterSettings {
  baseUrl: string;
  token: string;
  model: string;
}

export interface SchedulerSettings {
  maxConcurrent?: number;
  maxPerRunner?: Partial<Record<RunnerType, number>>;
}

export interface GlobalSettings {
  language: string;
  openRouter: OpenRouterSettings;
  scheduler?: SchedulerSettings;
}

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  isGitRepo: boolean;
  codexSettings: WorkspaceCodexSettings;
  promptTemplates?: WorkspacePromptTemplates;
  /** PR creation strategy for workspace-level agent coordination. */
  prStrategy?: "independent" | "stacked" | "single";
  /** When true, succeeded subtasks skip manual human approval. */
  autoApproveSubtasks?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface BuiltinModelConfig {
  mode: "builtin";
  id: string;
  reasoningEffort?: ReasoningEffort;
}

export interface CustomModelConfig {
  mode: "custom";
  id: string;
}

export type ModelConfig = BuiltinModelConfig | CustomModelConfig;

export const CLAUDE_BUILTIN_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5"
] as const;

export const CODEX_BUILTIN_MODELS = ["gpt-5.4"] as const;

export const CLAUDE_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high"
];

export const CODEX_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh"
];

export interface ShellRunnerConfig {
  type: "shell";
  command: string;
  env?: Record<string, string>;
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
  model?: ModelConfig;
  permissionMode?: ClaudePermissionMode;
  env?: Record<string, string>;
}

export interface CodexRunnerConfig {
  type: "codex";
  prompt: string;
  model?: ModelConfig;
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
  /** Task IDs that must be "done" before this task can start */
  dependencies: string[];
  plan?: string;
  worktree: TaskWorktree;
  lastRunId?: string;
  lastRunStatus?: RunStatus;
  continuationRunId?: string;
  pullRequestUrl?: string;
  pullRequest?: TaskPullRequest;
  /** Human reviewers explicitly rejected this subtask. */
  rejected?: boolean;
  /** Present when a team subtask was explicitly cancelled by a user. */
  cancelledAt?: string;
  /** Internal visibility bucket for UI-facing tasks. Defaults to `user`. */
  taskKind?: "user";
  /** When set, this task is a subtask created via an approved Plan. */
  parentTaskId?: string;
  /**
   * Agent-driven board: provenance of this task.
   * `user`        — hand-created from the kanban UI (default when missing).
   * `agent_plan`  — materialized by approving a Plan.
   * Optional on the TS side so legacy call sites that construct Task literals
   * keep compiling; the DB layer always populates it (default 'user').
   */
  source?: "user" | "agent_plan";
  /** Present when `source === "agent_plan"`; points at the originating Plan. */
  planId?: string;
  /** The WorkspaceAgent that should pick up this task (may be decided later). */
  assigneeAgentId?: string;
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
  logFile?: string;
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

// === Account-level Agents ===

export type AgentRole = "coordinator" | "worker";

/**
 * An account-level agent definition. Agents are created once and can be
 * mounted to multiple workspaces with different roles.
 */
export interface AccountAgent {
  id: string;
  name: string;
  description?: string;
  runnerConfig: RunnerConfig;
  createdAt: string;
  updatedAt: string;
}

/**
 * An AccountAgent with the role it was assigned when mounted to a workspace.
 * Returned by listWorkspaceAgents().
 */
export interface WorkspaceAgent extends AccountAgent {
  role: AgentRole;
}

// === Agent-driven board (Spec 02) ===

export type ThreadKind = "coordinator" | "task" | "direct";

export type CoordinatorState = "idle" | "queued" | "running";

export interface Thread {
  id: string;
  workspaceId: string;
  kind: ThreadKind;
  /** Set when `kind === "task"` — the task this thread belongs to. */
  taskId?: string;
  /** The WorkspaceAgent that drives this thread (if any). */
  coordinatorAgentId?: string;
  coordinatorState: CoordinatorState;
  createdAt: string;
  archivedAt?: string;
}

export type MessageKind =
  | "chat"
  | "status"
  | "tool_call"
  | "tool_output"
  | "artifact"
  | "plan_draft"
  | "plan_decision"
  | "system_event";

export type MessageSender =
  | { type: "user" }
  | { type: "agent"; agentId: string }
  | { type: "system" };

export interface Message {
  id: string;
  threadId: string;
  sender: MessageSender;
  kind: MessageKind;
  /** Payload shape is narrowed per `kind` by typia validators. */
  payload: unknown;
  /** When set, this message was consumed by the given coordinator run turn. */
  consumedByRunId?: string;
  createdAt: string;
}

export type PlanStatus = "pending" | "approved" | "rejected" | "superseded";

export interface PlanDraft {
  title: string;
  description: string;
  assigneeAgentId?: string;
  /** References to other drafts' titles within the same plan. */
  dependsOn?: string[];
}

export interface Plan {
  id: string;
  threadId: string;
  proposerAgentId: string;
  status: PlanStatus;
  drafts: PlanDraft[];
  approvedAt?: string;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  workspaceId: string;
  agentId: string;
  threadId: string;
  /** Runner-level session handle: claude `--resume` id, codex session id, etc. */
  runnerSessionKey?: string;
  createdAt: string;
}
