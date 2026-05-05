import type { tags } from "typia";

import type {
  AccountAgent,
  AgentRole,
  AppState,
  GlobalSettings,
  Message,
  MessageKind,
  Plan,
  RunnerConfig,
  RunnerType,
  Thread,
  ThreadKind,
  WorkspaceAgent,
  WorkspaceCodexSettings,
  WorkspaceHarness,
  WorkspacePromptTemplates,
  Run,
  RunLogEntry,
  Task,
  TaskColumn,
  WorkspaceGitRef,
  Workspace
} from "./domain.js";

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiErrorIssue {
  path: string;
  expected: string;
  value: unknown;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: ApiErrorIssue[] | string;
  };
}

export interface DeleteResult {
  id: string;
}

export interface SettingsData {
  settings: GlobalSettings;
}

export interface UpdateSettingsBody {
  language: string;
  openRouter: {
    baseUrl: string;
    token: string;
    model: string;
  };
  scheduler?: {
    maxConcurrent?: number;
  };
}

export interface ListWorkspacesData {
  items: Workspace[];
}

export interface WorkspaceData {
  workspace: Workspace;
}

export interface WorkspaceGitRefsData {
  items: WorkspaceGitRef[];
}

export interface PickWorkspaceRootData {
  rootPath: string | null;
}

export interface CreateWorkspaceBody {
  name: string;
  rootPath: string;
  codexSettings?: WorkspaceCodexSettings;
  promptTemplates?: WorkspacePromptTemplates;
}

export interface ListWorkspaceGitRefsParams {
  workspaceId: string;
}

export interface WorkspaceGitStatusParams {
  workspaceId: string;
}

export interface WorkspaceGitStatusData {
  branch: string;
  ahead: number;
  behind: number;
  changedFiles: number;
  addedFiles: number;
  deletedFiles: number;
}

export interface WorkspaceGitPullParams {
  workspaceId: string;
}

export interface WorkspaceGitPullData {
  success: boolean;
}

export interface WorkspaceHarnessParams {
  workspaceId: string;
}

export type WorkspaceHarnessData = WorkspaceHarness;

export interface UpdateWorkspaceParams {
  workspaceId: string;
}

export interface UpdateWorkspaceBody {
  name?: string;
  codexSettings?: WorkspaceCodexSettings;
  promptTemplates?: WorkspacePromptTemplates;
}

export interface DeleteWorkspaceParams {
  workspaceId: string;
}

export interface ListTasksQuery {
  workspaceId?: string;
}

export interface ListTasksData {
  items: Task[];
}

export interface TaskData {
  task: Task;
}

export interface CreateTaskBody {
  title: string;
  description?: string;
  workspaceId: string;
  worktreeBaseRef?: string;
  column?: TaskColumn;
  order?: number;
  assigneeAgentId?: string;
}

export interface UpdateTaskParams {
  taskId: string;
}

export interface ApproveTaskParams {
  taskId: string;
}

export interface RejectTaskParams {
  taskId: string;
}

export interface RejectTaskBody {
  reason?: string & tags.MaxLength<10_240>;
}

export interface RetryTaskParams {
  taskId: string;
}

export interface UpdateTaskBody {
  title?: string;
  description?: string;
  workspaceId?: string;
  worktreeBaseRef?: string;
  column?: TaskColumn;
  order?: number;
  assigneeAgentId?: string;
}

export interface DeleteTaskParams {
  taskId: string;
}

export interface StartTaskParams {
  taskId: string;
}

export interface StartTaskBody {
  order?: number;
  /**
   * When `false`, the task runs directly in the workspace root instead of an
   * isolated git worktree. Defaults to `true` (worktree-isolated). Only honored
   * for git workspaces; non-git workspaces always run in the workspace root.
   */
  useWorktree?: boolean;
}

export interface StopTaskParams {
  taskId: string;
}

export interface TaskInputParams {
  taskId: string;
}

export interface TaskInputBody {
  text: string;
}

export interface PlanTaskParams {
  taskId: string;
}

export interface RequestTaskReviewParams {
  taskId: string;
}

export interface RequestTaskReviewBody {
  /** Workspace agent id selected by the coordinator for this review. */
  reviewerAgentId?: string;
  /** Optional review focus, e.g. "technical review" or "business review". */
  focus?: string;
}

export interface StartTaskData {
  task: Task;
  run: Run;
}

export interface StopTaskData {
  task: Task;
  run: Run;
}

export interface TaskInputData {
  task: Task;
  run: Run;
}

export interface PlanTaskData {
  task: Task;
  run: Run;
}

export interface PlanFeedbackParams {
  taskId: string;
}

export interface PlanFeedbackBody {
  text: string;
}

export interface PlanFeedbackData {
  task: Task;
  run: Run;
}

export interface RequestTaskReviewData {
  task: Task;
  run: Run;
}

export interface TaskDiffParams {
  taskId: string;
}

export interface TaskDiffFile {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface TaskDiffData {
  files: TaskDiffFile[];
  baseRef: string;
  headRef: string;
}

export interface WorkspaceDiffParams {
  workspaceId: string;
}

export type WorkspaceDiffData = TaskDiffData;

export interface CleanupTaskWorktreeParams {
  taskId: string;
}

export interface CleanupTaskWorktreeData {
  task: Task;
}

export interface ListRunsParams {
  taskId: string;
}

export interface ListRunsData {
  items: Run[];
}

export interface RunLogParams {
  runId: string;
}

export interface RunLogData {
  items: RunLogEntry[];
}

export interface HealthReviewMonitorData {
  intervalMs: number;
  lastPolledAt?: string;
}

export type HealthCodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

export interface HealthCodexQuotaWindowData {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins?: number;
  resetsAt?: string;
}

export interface HealthCodexQuotaData {
  limitId?: string;
  planType?: HealthCodexPlanType;
  primary?: HealthCodexQuotaWindowData;
  secondary?: HealthCodexQuotaWindowData;
}

export interface HealthData {
  status: "ok";
  state: Pick<AppState, "schemaVersion">;
  reviewMonitor: HealthReviewMonitorData;
  codexQuota: HealthCodexQuotaData | null;
}

export interface SetTaskDependenciesParams {
  taskId: string;
}

export interface SetTaskDependenciesBody {
  dependencies: string[];
}

export interface GetTaskDependenciesParams {
  taskId: string;
}

export interface TaskDependenciesData {
  task: Task;
}

export interface SchedulerStatusData {
  running: number;
  queued: number;
  blocked: number;
}

export interface SchedulerEvaluateData {
  started: string[];
  blocked: string[];
}

export type SettingsResponse = ApiSuccess<SettingsData>;
export type WorkspacesResponse = ApiSuccess<ListWorkspacesData>;
export type WorkspaceResponse = ApiSuccess<WorkspaceData>;
export type WorkspaceGitRefsResponse = ApiSuccess<WorkspaceGitRefsData>;
export type WorkspaceGitStatusResponse = ApiSuccess<WorkspaceGitStatusData>;
export type WorkspaceGitPullResponse = ApiSuccess<WorkspaceGitPullData>;
export type WorkspaceHarnessResponse = ApiSuccess<WorkspaceHarnessData>;
export type PickWorkspaceRootResponse = ApiSuccess<PickWorkspaceRootData>;
export type DeleteWorkspaceResponse = ApiSuccess<DeleteResult>;
export type TasksResponse = ApiSuccess<ListTasksData>;
export type TaskResponse = ApiSuccess<TaskData>;
export type DeleteTaskResponse = ApiSuccess<DeleteResult>;
export type StartTaskResponse = ApiSuccess<StartTaskData>;
export type StopTaskResponse = ApiSuccess<StopTaskData>;
export type TaskInputResponse = ApiSuccess<TaskInputData>;
export type PlanTaskResponse = ApiSuccess<PlanTaskData>;
export type PlanFeedbackResponse = ApiSuccess<PlanFeedbackData>;
export type RequestTaskReviewResponse = ApiSuccess<RequestTaskReviewData>;
export type CleanupTaskWorktreeResponse = ApiSuccess<CleanupTaskWorktreeData>;
export type TaskDiffResponse = ApiSuccess<TaskDiffData>;
export type WorkspaceDiffResponse = ApiSuccess<WorkspaceDiffData>;
export type RunsResponse = ApiSuccess<ListRunsData>;
export type RunLogResponse = ApiSuccess<RunLogData>;
export type HealthResponse = ApiSuccess<HealthData>;
export type TaskDependenciesResponse = ApiSuccess<TaskDependenciesData>;
export type SchedulerStatusResponse = ApiSuccess<SchedulerStatusData>;
export type SchedulerEvaluateResponse = ApiSuccess<SchedulerEvaluateData>;

// === Account-level Agents (Phase 4) ===

export interface CreateAgentBody {
  name: string;
  description?: string;
  runnerConfig: RunnerConfig;
}

export interface UpdateAgentBody {
  name?: string;
  description?: string;
  runnerConfig?: RunnerConfig;
}

export interface AgentParams {
  agentId: string;
}

export interface ListWorkspaceAgentsParams {
  workspaceId: string;
}

export interface MountAgentBody {
  agentId: string;
  role: AgentRole;
  workspaceDescription?: string;
}

export interface WorkspaceAgentParams {
  workspaceId: string;
  agentId: string;
}

export interface UpdateAgentRoleBody {
  role?: AgentRole;
  workspaceDescription?: string;
}

export interface AgentData {
  agent: AccountAgent;
}

export interface ListAgentsData {
  items: AccountAgent[];
}

export interface WorkspaceAgentData {
  agent: WorkspaceAgent;
}

export interface ListWorkspaceAgentsData {
  items: WorkspaceAgent[];
}

export type AgentResponse = ApiSuccess<AgentData>;
export type ListAgentsResponse = ApiSuccess<ListAgentsData>;
export type DeleteAgentResponse = ApiSuccess<DeleteResult>;
export type WorkspaceAgentResponse = ApiSuccess<WorkspaceAgentData>;
export type ListWorkspaceAgentsResponse = ApiSuccess<ListWorkspaceAgentsData>;

// === Agent-driven board (Spec 02) ===

export interface ListThreadsParams {
  workspaceId: string;
}

export interface ListThreadsData {
  items: Thread[];
}

export interface ThreadData {
  thread: Thread;
}

export interface CreateThreadBody {
  kind: ThreadKind;
  taskId?: string;
  coordinatorAgentId?: string;
}

export interface PostThreadMessageParams {
  threadId: string;
}

export interface PostThreadMessageBody {
  content: string;
  /** Defaults to "chat" when omitted. Server may reject other kinds for human senders. */
  kind?: MessageKind;
}

export interface ListThreadMessagesParams {
  threadId: string;
}

export interface ListThreadMessagesQuery {
  /** Message id cursor — return messages created strictly after this one. */
  after?: string;
  limit?: number & tags.Type<"int32"> & tags.Minimum<1> & tags.Maximum<500>;
}

export interface ListThreadMessagesData {
  items: Message[];
}

export interface MessageData {
  message: Message;
}

export interface PlanParams {
  planId: string;
}

export interface PlanData {
  plan: Plan;
}

export type ListThreadsResponse = ApiSuccess<ListThreadsData>;
export type ThreadResponse = ApiSuccess<ThreadData>;
export type ListThreadMessagesResponse = ApiSuccess<ListThreadMessagesData>;
export type MessageResponse = ApiSuccess<MessageData>;
export type PlanResponse = ApiSuccess<PlanData>;

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface EndpointResponseSpec {
  status: number;
  description: string;
  schema: SchemaName;
}

export interface EndpointSpec {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  tag: string;
  paramsSchema?: SchemaName;
  querySchema?: SchemaName;
  bodySchema?: SchemaName;
  responses: EndpointResponseSpec[];
}

export type SchemaName =
  | "ApiError"
  | "GlobalSettings"
  | "UpdateSettingsBody"
  | "SettingsResponse"
  | "Workspace"
  | "WorkspaceGitRef"
  | "PickWorkspaceRootResponse"
  | "Task"
  | "Run"
  | "CreateWorkspaceBody"
  | "ListWorkspaceGitRefsParams"
  | "WorkspaceGitStatusParams"
  | "WorkspaceGitPullParams"
  | "WorkspaceHarnessParams"
  | "WorkspaceHarnessResponse"
  | "UpdateWorkspaceBody"
  | "UpdateWorkspaceParams"
  | "DeleteWorkspaceParams"
  | "ListTasksQuery"
  | "CreateTaskBody"
  | "ApproveTaskParams"
  | "RejectTaskParams"
  | "RejectTaskBody"
  | "RetryTaskParams"
  | "UpdateTaskParams"
  | "UpdateTaskBody"
  | "DeleteTaskParams"
  | "StartTaskParams"
  | "StartTaskBody"
  | "StopTaskParams"
  | "TaskInputParams"
  | "TaskInputBody"
  | "PlanTaskParams"
  | "PlanFeedbackParams"
  | "PlanFeedbackBody"
  | "RequestTaskReviewParams"
  | "RequestTaskReviewBody"
  | "CleanupTaskWorktreeParams"
  | "TaskDiffParams"
  | "WorkspaceDiffParams"
  | "ListRunsParams"
  | "RunLogParams"
  | "WorkspacesResponse"
  | "WorkspaceResponse"
  | "WorkspaceGitRefsResponse"
  | "WorkspaceGitStatusResponse"
  | "WorkspaceGitPullResponse"
  | "DeleteWorkspaceResponse"
  | "TasksResponse"
  | "TaskResponse"
  | "DeleteTaskResponse"
  | "StartTaskResponse"
  | "StopTaskResponse"
  | "TaskInputResponse"
  | "PlanTaskResponse"
  | "PlanFeedbackResponse"
  | "RequestTaskReviewResponse"
  | "CleanupTaskWorktreeResponse"
  | "TaskDiffResponse"
  | "WorkspaceDiffResponse"
  | "RunsResponse"
  | "RunLogResponse"
  | "HealthResponse"
  | "SetTaskDependenciesParams"
  | "SetTaskDependenciesBody"
  | "GetTaskDependenciesParams"
  | "TaskDependenciesResponse"
  | "SchedulerStatusResponse"
  | "SchedulerEvaluateResponse"
  | "AccountAgent"
  | "WorkspaceAgent"
  | "CreateAgentBody"
  | "UpdateAgentBody"
  | "AgentParams"
  | "ListWorkspaceAgentsParams"
  | "MountAgentBody"
  | "WorkspaceAgentParams"
  | "UpdateAgentRoleBody"
  | "AgentResponse"
  | "ListAgentsResponse"
  | "DeleteAgentResponse"
  | "WorkspaceAgentResponse"
  | "ListWorkspaceAgentsResponse"
  | "Thread"
  | "Message"
  | "Plan"
  | "ListThreadsParams"
  | "CreateThreadBody"
  | "PostThreadMessageParams"
  | "PostThreadMessageBody"
  | "ListThreadMessagesParams"
  | "ListThreadMessagesQuery"
  | "PlanParams"
  | "ListThreadsResponse"
  | "ThreadResponse"
  | "ListThreadMessagesResponse"
  | "MessageResponse"
  | "PlanResponse";

export const endpointRegistry: EndpointSpec[] = [
  {
    operationId: "health",
    method: "get",
    path: "/api/health",
    summary: "Read runtime health",
    tag: "Runtime",
    responses: [
      {
        status: 200,
        description: "Runtime health information",
        schema: "HealthResponse"
      }
    ]
  },
  {
    operationId: "getSettings",
    method: "get",
    path: "/api/settings",
    summary: "Read global settings",
    tag: "Settings",
    responses: [
      {
        status: 200,
        description: "Global settings",
        schema: "SettingsResponse"
      }
    ]
  },
  {
    operationId: "updateSettings",
    method: "patch",
    path: "/api/settings",
    summary: "Update global settings",
    tag: "Settings",
    bodySchema: "UpdateSettingsBody",
    responses: [
      {
        status: 200,
        description: "Updated global settings",
        schema: "SettingsResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "listWorkspaces",
    method: "get",
    path: "/api/workspaces",
    summary: "List registered workspaces",
    tag: "Workspaces",
    responses: [
      {
        status: 200,
        description: "Workspace collection",
        schema: "WorkspacesResponse"
      }
    ]
  },
  {
    operationId: "pickWorkspaceRoot",
    method: "post",
    path: "/api/workspaces/pick-root",
    summary: "Open a local folder picker for a workspace root",
    tag: "Workspaces",
    responses: [
      {
        status: 200,
        description: "Selected workspace root path, or null when canceled",
        schema: "PickWorkspaceRootResponse"
      },
      {
        status: 501,
        description: "Folder picker is unavailable on this platform",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "createWorkspace",
    method: "post",
    path: "/api/workspaces",
    summary: "Register a workspace",
    tag: "Workspaces",
    bodySchema: "CreateWorkspaceBody",
    responses: [
      {
        status: 201,
        description: "Created workspace",
        schema: "WorkspaceResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "updateWorkspace",
    method: "patch",
    path: "/api/workspaces/{workspaceId}",
    summary: "Rename a workspace",
    tag: "Workspaces",
    paramsSchema: "UpdateWorkspaceParams",
    bodySchema: "UpdateWorkspaceBody",
    responses: [
      {
        status: 200,
        description: "Updated workspace",
        schema: "WorkspaceResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Workspace not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "listWorkspaceGitRefs",
    method: "get",
    path: "/api/workspaces/{workspaceId}/git/refs",
    summary: "List Git refs for a workspace",
    tag: "Workspaces",
    paramsSchema: "ListWorkspaceGitRefsParams",
    responses: [
      {
        status: 200,
        description: "Workspace Git refs",
        schema: "WorkspaceGitRefsResponse"
      },
      {
        status: 404,
        description: "Workspace not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "getWorkspaceGitStatus",
    method: "get",
    path: "/api/workspaces/{workspaceId}/git/status",
    summary: "Get Git sync status for a workspace",
    tag: "Workspaces",
    paramsSchema: "WorkspaceGitStatusParams",
    responses: [
      {
        status: 200,
        description: "Workspace Git sync status",
        schema: "WorkspaceGitStatusResponse"
      },
      {
        status: 404,
        description: "Workspace not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "pullWorkspace",
    method: "post",
    path: "/api/workspaces/{workspaceId}/git/pull",
    summary: "Pull latest changes from origin for a workspace",
    tag: "Workspaces",
    paramsSchema: "WorkspaceGitPullParams",
    responses: [
      {
        status: 200,
        description: "Pull result",
        schema: "WorkspaceGitPullResponse"
      },
      {
        status: 400,
        description: "Pull failed",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Workspace not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "getWorkspaceHarness",
    method: "get",
    path: "/api/workspaces/{workspaceId}/harness",
    summary: "Read project-level harness files (CLAUDE.md, AGENTS.md) from the workspace root",
    tag: "Workspaces",
    paramsSchema: "WorkspaceHarnessParams",
    responses: [
      {
        status: 200,
        description: "Harness file metadata and content",
        schema: "WorkspaceHarnessResponse"
      },
      {
        status: 404,
        description: "Workspace not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "deleteWorkspace",
    method: "delete",
    path: "/api/workspaces/{workspaceId}",
    summary: "Delete a workspace",
    tag: "Workspaces",
    paramsSchema: "DeleteWorkspaceParams",
    responses: [
      {
        status: 200,
        description: "Deleted workspace id",
        schema: "DeleteWorkspaceResponse"
      },
      {
        status: 404,
        description: "Workspace not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "listTasks",
    method: "get",
    path: "/api/tasks",
    summary: "List tasks across workspaces",
    tag: "Tasks",
    querySchema: "ListTasksQuery",
    responses: [
      {
        status: 200,
        description: "Task collection",
        schema: "TasksResponse"
      }
    ]
  },
  {
    operationId: "createTask",
    method: "post",
    path: "/api/tasks",
    summary: "Create a task card",
    tag: "Tasks",
    bodySchema: "CreateTaskBody",
    responses: [
      {
        status: 201,
        description: "Created task",
        schema: "TaskResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "updateTask",
    method: "patch",
    path: "/api/tasks/{taskId}",
    summary: "Update a task card",
    tag: "Tasks",
    paramsSchema: "UpdateTaskParams",
    bodySchema: "UpdateTaskBody",
    responses: [
      {
        status: 200,
        description: "Updated task",
        schema: "TaskResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "approveTask",
    method: "post",
    path: "/api/tasks/{taskId}/approve",
    summary: "Approve a review-ready subtask",
    tag: "Tasks",
    paramsSchema: "ApproveTaskParams",
    responses: [
      {
        status: 200,
        description: "Approved task",
        schema: "TaskResponse"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      },
      {
        status: 409,
        description: "Task cannot be approved",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "rejectTask",
    method: "post",
    path: "/api/tasks/{taskId}/reject",
    summary: "Reject a review-ready subtask",
    tag: "Tasks",
    paramsSchema: "RejectTaskParams",
    bodySchema: "RejectTaskBody",
    responses: [
      {
        status: 200,
        description: "Rejected task",
        schema: "TaskResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      },
      {
        status: 409,
        description: "Task cannot be rejected",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "retryTask",
    method: "post",
    path: "/api/tasks/{taskId}/retry",
    summary: "Retry a review-ready subtask",
    tag: "Tasks",
    paramsSchema: "RetryTaskParams",
    responses: [
      {
        status: 200,
        description: "Retried task",
        schema: "TaskResponse"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      },
      {
        status: 409,
        description: "Task cannot be retried",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "deleteTask",
    method: "delete",
    path: "/api/tasks/{taskId}",
    summary: "Delete a task card",
    tag: "Tasks",
    paramsSchema: "DeleteTaskParams",
    responses: [
      {
        status: 200,
        description: "Deleted task id",
        schema: "DeleteTaskResponse"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "cleanupTaskWorktree",
    method: "post",
    path: "/api/tasks/{taskId}/worktree/cleanup",
    summary: "Cleanup a task worktree",
    tag: "Tasks",
    paramsSchema: "CleanupTaskWorktreeParams",
    responses: [
      {
        status: 200,
        description: "Cleaned up task worktree",
        schema: "CleanupTaskWorktreeResponse"
      },
      {
        status: 400,
        description: "Unable to cleanup task worktree",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "startTask",
    method: "post",
    path: "/api/tasks/{taskId}/start",
    summary: "Start task execution",
    tag: "Runs",
    paramsSchema: "StartTaskParams",
    bodySchema: "StartTaskBody",
    responses: [
      {
        status: 200,
        description: "Started run",
        schema: "StartTaskResponse"
      },
      {
        status: 400,
        description: "Unable to start task",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "stopTask",
    method: "post",
    path: "/api/tasks/{taskId}/stop",
    summary: "Stop task execution",
    tag: "Runs",
    paramsSchema: "StopTaskParams",
    responses: [
      {
        status: 200,
        description: "Stopped run",
        schema: "StopTaskResponse"
      },
      {
        status: 400,
        description: "Unable to stop task",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "sendTaskInput",
    method: "post",
    path: "/api/tasks/{taskId}/input",
    summary: "Send a user message to the task's Codex session",
    tag: "Runs",
    paramsSchema: "TaskInputParams",
    bodySchema: "TaskInputBody",
    responses: [
      {
        status: 200,
        description: "Accepted task input",
        schema: "TaskInputResponse"
      },
      {
        status: 400,
        description: "Unable to accept task input",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "planTask",
    method: "post",
    path: "/api/tasks/{taskId}/plan",
    summary: "Create a task plan and move it to todo",
    tag: "Tasks",
    paramsSchema: "PlanTaskParams",
    responses: [
      {
        status: 200,
        description: "Planned task",
        schema: "PlanTaskResponse"
      },
      {
        status: 400,
        description: "Unable to plan task",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "sendPlanFeedback",
    method: "post",
    path: "/api/tasks/{taskId}/plan-feedback",
    summary: "Send feedback to refine a task plan via session resume",
    tag: "Tasks",
    paramsSchema: "PlanFeedbackParams",
    bodySchema: "PlanFeedbackBody",
    responses: [
      {
        status: 200,
        description: "Started plan feedback run",
        schema: "PlanFeedbackResponse"
      },
      {
        status: 400,
        description: "Unable to send plan feedback",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "requestTaskReview",
    method: "post",
    path: "/api/tasks/{taskId}/review-request",
    summary: "Request an agent review for a task in review",
    tag: "Runs",
    paramsSchema: "RequestTaskReviewParams",
    bodySchema: "RequestTaskReviewBody",
    responses: [
      {
        status: 200,
        description: "Started review run",
        schema: "RequestTaskReviewResponse"
      },
      {
        status: 400,
        description: "Unable to request review",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "getTaskDiff",
    method: "get",
    path: "/api/tasks/{taskId}/diff",
    summary: "Get the file diff for a task worktree",
    tag: "Tasks",
    paramsSchema: "TaskDiffParams",
    responses: [
      {
        status: 200,
        description: "Task diff content",
        schema: "TaskDiffResponse"
      },
      {
        status: 400,
        description: "Diff not available",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "getWorkspaceDiff",
    method: "get",
    path: "/api/workspaces/{workspaceId}/diff",
    summary: "Get uncommitted file diff for the workspace root",
    tag: "Workspaces",
    paramsSchema: "WorkspaceDiffParams",
    responses: [
      {
        status: 200,
        description: "Workspace diff content",
        schema: "WorkspaceDiffResponse"
      },
      {
        status: 400,
        description: "Diff not available",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Workspace not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "listRuns",
    method: "get",
    path: "/api/tasks/{taskId}/runs",
    summary: "List task runs",
    tag: "Runs",
    paramsSchema: "ListRunsParams",
    responses: [
      {
        status: 200,
        description: "Run collection",
        schema: "RunsResponse"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "getRunLog",
    method: "get",
    path: "/api/runs/{runId}/log",
    summary: "Read a stored run log",
    tag: "Runs",
    paramsSchema: "RunLogParams",
    responses: [
      {
        status: 200,
        description: "Run log content",
        schema: "RunLogResponse"
      },
      {
        status: 404,
        description: "Run not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "setTaskDependencies",
    method: "put",
    path: "/api/tasks/{taskId}/dependencies",
    summary: "Set task dependency list",
    tag: "Tasks",
    paramsSchema: "SetTaskDependenciesParams",
    bodySchema: "SetTaskDependenciesBody",
    responses: [
      {
        status: 200,
        description: "Updated task",
        schema: "TaskDependenciesResponse"
      },
      {
        status: 400,
        description: "Validation error or cycle detected",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "getTaskDependencies",
    method: "get",
    path: "/api/tasks/{taskId}/dependencies",
    summary: "Get task dependencies",
    tag: "Tasks",
    paramsSchema: "GetTaskDependenciesParams",
    responses: [
      {
        status: 200,
        description: "Task with dependencies",
        schema: "TaskDependenciesResponse"
      },
      {
        status: 404,
        description: "Task not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "getSchedulerStatus",
    method: "get",
    path: "/api/scheduler/status",
    summary: "Get task scheduler status",
    tag: "Scheduler",
    responses: [
      {
        status: 200,
        description: "Scheduler status snapshot",
        schema: "SchedulerStatusResponse"
      }
    ]
  },
  {
    operationId: "evaluateScheduler",
    method: "post",
    path: "/api/scheduler/evaluate",
    summary: "Manually trigger scheduler evaluation",
    tag: "Scheduler",
    responses: [
      {
        status: 200,
        description: "Evaluation result",
        schema: "SchedulerEvaluateResponse"
      }
    ]
  },
  // === Account-level Agents (Phase 4) ===
  {
    operationId: "listAgents",
    method: "get",
    path: "/api/agents",
    summary: "List all account-level agents",
    tag: "Agents",
    responses: [
      {
        status: 200,
        description: "Agent collection",
        schema: "ListAgentsResponse"
      }
    ]
  },
  {
    operationId: "createAgent",
    method: "post",
    path: "/api/agents",
    summary: "Create a new account-level agent",
    tag: "Agents",
    bodySchema: "CreateAgentBody",
    responses: [
      {
        status: 201,
        description: "Created agent",
        schema: "AgentResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "getAgent",
    method: "get",
    path: "/api/agents/{agentId}",
    summary: "Get an agent by ID",
    tag: "Agents",
    paramsSchema: "AgentParams",
    responses: [
      {
        status: 200,
        description: "Agent",
        schema: "AgentResponse"
      },
      {
        status: 404,
        description: "Agent not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "updateAgent",
    method: "patch",
    path: "/api/agents/{agentId}",
    summary: "Update an agent",
    tag: "Agents",
    paramsSchema: "AgentParams",
    bodySchema: "UpdateAgentBody",
    responses: [
      {
        status: 200,
        description: "Updated agent",
        schema: "AgentResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Agent not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "deleteAgent",
    method: "delete",
    path: "/api/agents/{agentId}",
    summary: "Delete an agent",
    tag: "Agents",
    paramsSchema: "AgentParams",
    responses: [
      {
        status: 200,
        description: "Deleted agent id",
        schema: "DeleteAgentResponse"
      },
      {
        status: 404,
        description: "Agent not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "listWorkspaceAgents",
    method: "get",
    path: "/api/workspaces/{workspaceId}/agents",
    summary: "List agents mounted to a workspace",
    tag: "Agents",
    paramsSchema: "ListWorkspaceAgentsParams",
    responses: [
      {
        status: 200,
        description: "Workspace agent collection",
        schema: "ListWorkspaceAgentsResponse"
      },
      {
        status: 404,
        description: "Workspace not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "mountAgent",
    method: "post",
    path: "/api/workspaces/{workspaceId}/agents",
    summary: "Mount an agent to a workspace",
    tag: "Agents",
    paramsSchema: "ListWorkspaceAgentsParams",
    bodySchema: "MountAgentBody",
    responses: [
      {
        status: 201,
        description: "Mounted workspace agent",
        schema: "WorkspaceAgentResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Workspace or agent not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "unmountAgent",
    method: "delete",
    path: "/api/workspaces/{workspaceId}/agents/{agentId}",
    summary: "Unmount an agent from a workspace",
    tag: "Agents",
    paramsSchema: "WorkspaceAgentParams",
    responses: [
      {
        status: 200,
        description: "Unmounted agent id",
        schema: "DeleteAgentResponse"
      },
      {
        status: 404,
        description: "Workspace agent not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "updateAgentRole",
    method: "patch",
    path: "/api/workspaces/{workspaceId}/agents/{agentId}",
    summary: "Update a workspace-mounted agent",
    tag: "Agents",
    paramsSchema: "WorkspaceAgentParams",
    bodySchema: "UpdateAgentRoleBody",
    responses: [
      {
        status: 200,
        description: "Updated workspace agent",
        schema: "WorkspaceAgentResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Workspace agent not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "listWorkspaceThreads",
    method: "get",
    path: "/api/workspaces/{workspaceId}/threads",
    summary: "List threads for a workspace",
    tag: "Threads",
    paramsSchema: "ListThreadsParams",
    responses: [
      {
        status: 200,
        description: "Workspace threads",
        schema: "ListThreadsResponse"
      }
    ]
  },
  {
    operationId: "createWorkspaceThread",
    method: "post",
    path: "/api/workspaces/{workspaceId}/threads",
    summary: "Create a thread in a workspace",
    tag: "Threads",
    paramsSchema: "ListThreadsParams",
    bodySchema: "CreateThreadBody",
    responses: [
      {
        status: 201,
        description: "Created thread",
        schema: "ThreadResponse"
      }
    ]
  },
  {
    operationId: "listThreadMessages",
    method: "get",
    path: "/api/threads/{threadId}/messages",
    summary: "List messages in a thread",
    tag: "Threads",
    paramsSchema: "ListThreadMessagesParams",
    querySchema: "ListThreadMessagesQuery",
    responses: [
      {
        status: 200,
        description: "Messages in the thread",
        schema: "ListThreadMessagesResponse"
      },
      {
        status: 404,
        description: "Thread not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "postThreadMessage",
    method: "post",
    path: "/api/threads/{threadId}/messages",
    summary: "Append a chat message to a thread",
    tag: "Threads",
    paramsSchema: "PostThreadMessageParams",
    bodySchema: "PostThreadMessageBody",
    responses: [
      {
        status: 200,
        description: "Appended message",
        schema: "MessageResponse"
      },
      {
        status: 404,
        description: "Thread not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "restartCoordinatorThread",
    method: "post",
    path: "/api/threads/{threadId}/restart",
    summary: "Restart a coordinator thread using the workspace coordinator",
    tag: "Threads",
    paramsSchema: "PostThreadMessageParams",
    responses: [
      {
        status: 200,
        description: "Restarted coordinator thread",
        schema: "ThreadResponse"
      },
      {
        status: 404,
        description: "Thread not found",
        schema: "ApiError"
      },
      {
        status: 409,
        description: "Coordinator is not configured for the workspace",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "approvePlan",
    method: "post",
    path: "/api/plans/{planId}/approve",
    summary: "Approve a plan and materialize its subtasks",
    tag: "Plans",
    paramsSchema: "PlanParams",
    responses: [
      {
        status: 200,
        description: "Approved plan",
        schema: "PlanResponse"
      },
      {
        status: 409,
        description: "Plan already decided",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "rejectPlan",
    method: "post",
    path: "/api/plans/{planId}/reject",
    summary: "Reject a plan",
    tag: "Plans",
    paramsSchema: "PlanParams",
    responses: [
      {
        status: 200,
        description: "Rejected plan",
        schema: "PlanResponse"
      },
      {
        status: 409,
        description: "Plan already decided",
        schema: "ApiError"
      }
    ]
  }
];
