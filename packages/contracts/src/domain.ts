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
  prStrategy?: TeamPrStrategy;
  /** When true, succeeded subtasks skip manual human approval. */
  autoApproveSubtasks?: boolean;
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
  /** When set, this task belongs to an agent team. */
  teamId?: string;
  /** When set, this task is a subtask created by a team coordinator. */
  parentTaskId?: string;
  /** The TeamAgent.id responsible for this subtask. */
  teamAgentId?: string;
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

// === Agent Teams ===

export type AgentRole = "coordinator" | "worker";

export type TeamPrStrategy = "independent" | "stacked" | "single";

export interface TeamAgent {
  /** Unique agent identifier within the team (nanoid). */
  id: string;
  agentName: string;
  role: AgentRole;
  runnerConfig: RunnerConfig;
}

export type TeamMessageSenderType = "agent" | "human" | "system";

export type TeamMessageType = "status" | "artifact" | "context" | "feedback";

export interface TeamMessage {
  id: string;
  teamId: string;
  /** Parent team task that owns this execution thread. */
  parentTaskId: string;
  /** The task this message is associated with (subtask or parent task). */
  taskId?: string;
  /** Name of the agent or user that sent the message. */
  agentName: string;
  /** Whether the message was sent by an agent, human, or the system. */
  senderType: TeamMessageSenderType;
  /** Semantic message category for prompt injection and UI rendering. */
  messageType: TeamMessageType;
  content: string;
  createdAt: string;
}

export interface AgentTeam {
  id: string;
  name: string;
  description: string;
  workspaceId: string;
  // agents is stored as a JSON column — always loaded with the team,
  // so a separate table would add overhead without query benefit.
  agents: TeamAgent[];
  /** Strategy for creating pull requests from subtask branches. */
  prStrategy: TeamPrStrategy;
  /** When true, succeeded subtasks skip manual human approval. */
  autoApproveSubtasks: boolean;
  createdAt: string;
  updatedAt: string;
}

// === Account-level Agents ===

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

// === Task Messages (workspace-level agent communication) ===

/** A message in a task's coordination thread, not tied to any team entity. */
export interface TaskMessage {
  id: string;
  /** The parent coordinator task that owns this execution thread. */
  parentTaskId: string;
  /** The specific subtask this message is associated with (if any). */
  taskId?: string;
  agentName: string;
  senderType: TeamMessageSenderType;
  messageType: TeamMessageType;
  content: string;
  createdAt: string;
}

// === Coordinator Proposals ===

export type CoordinatorProposalStatus = "pending" | "approved" | "rejected";

/** A single subtask draft produced by the coordinator LLM output. */
export interface CoordinatorProposalDraft {
  title: string;
  description: string;
  assignedAgent: string;
  dependencies: string[];
}

/**
 * A coordinator proposal holds the parsed subtask plan from a coordinator
 * run and waits for human approval before subtasks are actually created.
 */
export interface CoordinatorProposal {
  id: string;
  /** Legacy: team-scoped proposals. Null for workspace-scoped proposals. */
  teamId: string | null;
  /** Set for workspace-scoped proposals (new model). */
  workspaceId?: string;
  parentTaskId: string;
  status: CoordinatorProposalStatus;
  drafts: CoordinatorProposalDraft[];
  createdAt: string;
  /** ISO timestamp of when the proposal was approved or rejected. */
  decidedAt?: string;
}
