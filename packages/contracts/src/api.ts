import type {
  AgentTeam,
  AgentRole,
  AppState,
  GlobalSettings,
  RunnerConfig,
  RunnerType,
  TeamPrStrategy,
  WorkspaceCodexSettings,
  WorkspacePromptTemplates,
  Run,
  RunLogEntry,
  Task,
  TaskColumn,
  TeamMessage,
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
  teamId?: string;
  worktreeBaseRef?: string;
  column?: TaskColumn;
  order?: number;
  runnerType: RunnerType;
  runnerConfig: RunnerConfig;
}

export interface UpdateTaskParams {
  taskId: string;
}

export interface UpdateTaskBody {
  title?: string;
  description?: string;
  workspaceId?: string;
  worktreeBaseRef?: string;
  column?: TaskColumn;
  order?: number;
  runnerType?: RunnerType;
  runnerConfig?: RunnerConfig;
}

export interface DeleteTaskParams {
  taskId: string;
}

export interface StartTaskParams {
  taskId: string;
}

export interface StartTaskBody {
  order?: number;
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
export type RunsResponse = ApiSuccess<ListRunsData>;
export type RunLogResponse = ApiSuccess<RunLogData>;
export type HealthResponse = ApiSuccess<HealthData>;
export type TaskDependenciesResponse = ApiSuccess<TaskDependenciesData>;
export type SchedulerStatusResponse = ApiSuccess<SchedulerStatusData>;
export type SchedulerEvaluateResponse = ApiSuccess<SchedulerEvaluateData>;

// === Agent Teams ===

export interface ListTeamsQuery {
  workspaceId?: string;
}

export interface CreateTeamBody {
  name: string;
  description?: string;
  workspaceId: string;
  prStrategy?: TeamPrStrategy;
  agents: Array<{
    id: string;
    agentName: string;
    role: AgentRole;
    runnerConfig: RunnerConfig;
  }>;
}

export interface UpdateTeamParams {
  teamId: string;
}

export interface UpdateTeamBody {
  name?: string;
  description?: string;
  prStrategy?: TeamPrStrategy;
  agents?: Array<{
    id: string;
    agentName: string;
    role: AgentRole;
    runnerConfig: RunnerConfig;
  }>;
}

export interface GetTeamParams {
  teamId: string;
}

export interface DeleteTeamParams {
  teamId: string;
}

export interface ListTeamMessagesParams {
  teamId: string;
}

export interface ListTeamMessagesQuery {
  parentTaskId?: string;
}

export interface PostTeamMessageBody {
  parentTaskId: string;
  content: string;
}

export interface ListTeamsData {
  items: AgentTeam[];
}

export interface AgentTeamData {
  team: AgentTeam;
}

export interface TeamMessagesData {
  items: TeamMessage[];
}

export interface TeamMessageData {
  item: TeamMessage;
}

export type TeamsResponse = ApiSuccess<ListTeamsData>;
export type AgentTeamResponse = ApiSuccess<AgentTeamData>;
export type DeleteTeamResponse = ApiSuccess<DeleteResult>;
export type TeamMessagesResponse = ApiSuccess<TeamMessagesData>;
export type TeamMessageResponse = ApiSuccess<TeamMessageData>;

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
  | "UpdateWorkspaceBody"
  | "UpdateWorkspaceParams"
  | "DeleteWorkspaceParams"
  | "ListTasksQuery"
  | "CreateTaskBody"
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
  | "CleanupTaskWorktreeParams"
  | "TaskDiffParams"
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
  | "RunsResponse"
  | "RunLogResponse"
  | "HealthResponse"
  | "SetTaskDependenciesParams"
  | "SetTaskDependenciesBody"
  | "GetTaskDependenciesParams"
  | "TaskDependenciesResponse"
  | "SchedulerStatusResponse"
  | "SchedulerEvaluateResponse"
  | "ListTeamsQuery"
  | "CreateTeamBody"
  | "UpdateTeamParams"
  | "UpdateTeamBody"
  | "GetTeamParams"
  | "DeleteTeamParams"
  | "ListTeamMessagesParams"
  | "ListTeamMessagesQuery"
  | "PostTeamMessageBody"
  | "TeamsResponse"
  | "AgentTeamResponse"
  | "DeleteTeamResponse"
  | "TeamMessagesResponse"
  | "TeamMessageResponse";

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
    summary: "Request a Claude review for a task in review",
    tag: "Runs",
    paramsSchema: "RequestTaskReviewParams",
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
  {
    operationId: "listTeams",
    method: "get",
    path: "/api/teams",
    summary: "List agent teams",
    tag: "Teams",
    querySchema: "ListTeamsQuery",
    responses: [
      {
        status: 200,
        description: "Team collection",
        schema: "TeamsResponse"
      }
    ]
  },
  {
    operationId: "createTeam",
    method: "post",
    path: "/api/teams",
    summary: "Create an agent team",
    tag: "Teams",
    bodySchema: "CreateTeamBody",
    responses: [
      {
        status: 201,
        description: "Created team",
        schema: "AgentTeamResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "getTeam",
    method: "get",
    path: "/api/teams/{teamId}",
    summary: "Get an agent team",
    tag: "Teams",
    paramsSchema: "GetTeamParams",
    responses: [
      {
        status: 200,
        description: "Team details",
        schema: "AgentTeamResponse"
      },
      {
        status: 404,
        description: "Team not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "updateTeam",
    method: "patch",
    path: "/api/teams/{teamId}",
    summary: "Update an agent team",
    tag: "Teams",
    paramsSchema: "UpdateTeamParams",
    bodySchema: "UpdateTeamBody",
    responses: [
      {
        status: 200,
        description: "Updated team",
        schema: "AgentTeamResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Team not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "deleteTeam",
    method: "delete",
    path: "/api/teams/{teamId}",
    summary: "Delete an agent team",
    tag: "Teams",
    paramsSchema: "DeleteTeamParams",
    responses: [
      {
        status: 200,
        description: "Deleted team id",
        schema: "DeleteTeamResponse"
      },
      {
        status: 404,
        description: "Team not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "listTeamMessages",
    method: "get",
    path: "/api/teams/{teamId}/messages",
    summary: "List messages for a team",
    tag: "Teams",
    paramsSchema: "ListTeamMessagesParams",
    querySchema: "ListTeamMessagesQuery",
    responses: [
      {
        status: 200,
        description: "Team message collection",
        schema: "TeamMessagesResponse"
      },
      {
        status: 404,
        description: "Team not found",
        schema: "ApiError"
      }
    ]
  },
  {
    operationId: "postTeamMessage",
    method: "post",
    path: "/api/teams/{teamId}/messages",
    summary: "Post a human message into a team task thread",
    tag: "Teams",
    paramsSchema: "ListTeamMessagesParams",
    bodySchema: "PostTeamMessageBody",
    responses: [
      {
        status: 201,
        description: "Created team message",
        schema: "TeamMessageResponse"
      },
      {
        status: 400,
        description: "Validation error",
        schema: "ApiError"
      },
      {
        status: 404,
        description: "Team not found",
        schema: "ApiError"
      }
    ]
  }
];
