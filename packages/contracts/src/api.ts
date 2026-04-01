import type {
  AppState,
  WorkspaceCodexSettings,
  Run,
  RunLogEntry,
  RunnerConfig,
  RunnerType,
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

export interface ListWorkspacesData {
  items: Workspace[];
}

export interface WorkspaceData {
  workspace: Workspace;
}

export interface WorkspaceGitRefsData {
  items: WorkspaceGitRef[];
}

export interface CreateWorkspaceBody {
  name: string;
  rootPath: string;
  codexSettings?: WorkspaceCodexSettings;
}

export interface ListWorkspaceGitRefsParams {
  workspaceId: string;
}

export interface UpdateWorkspaceParams {
  workspaceId: string;
}

export interface UpdateWorkspaceBody {
  name?: string;
  codexSettings?: WorkspaceCodexSettings;
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
  plan: string;
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

export type WorkspacesResponse = ApiSuccess<ListWorkspacesData>;
export type WorkspaceResponse = ApiSuccess<WorkspaceData>;
export type WorkspaceGitRefsResponse = ApiSuccess<WorkspaceGitRefsData>;
export type DeleteWorkspaceResponse = ApiSuccess<DeleteResult>;
export type TasksResponse = ApiSuccess<ListTasksData>;
export type TaskResponse = ApiSuccess<TaskData>;
export type DeleteTaskResponse = ApiSuccess<DeleteResult>;
export type StartTaskResponse = ApiSuccess<StartTaskData>;
export type StopTaskResponse = ApiSuccess<StopTaskData>;
export type TaskInputResponse = ApiSuccess<TaskInputData>;
export type PlanTaskResponse = ApiSuccess<PlanTaskData>;
export type CleanupTaskWorktreeResponse = ApiSuccess<CleanupTaskWorktreeData>;
export type RunsResponse = ApiSuccess<ListRunsData>;
export type RunLogResponse = ApiSuccess<RunLogData>;
export type HealthResponse = ApiSuccess<HealthData>;

export type HttpMethod = "get" | "post" | "patch" | "delete";

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
  | "Workspace"
  | "WorkspaceGitRef"
  | "Task"
  | "Run"
  | "CreateWorkspaceBody"
  | "ListWorkspaceGitRefsParams"
  | "UpdateWorkspaceBody"
  | "UpdateWorkspaceParams"
  | "DeleteWorkspaceParams"
  | "ListTasksQuery"
  | "CreateTaskBody"
  | "UpdateTaskParams"
  | "UpdateTaskBody"
  | "DeleteTaskParams"
  | "StartTaskParams"
  | "StopTaskParams"
  | "TaskInputParams"
  | "TaskInputBody"
  | "PlanTaskParams"
  | "CleanupTaskWorktreeParams"
  | "ListRunsParams"
  | "RunLogParams"
  | "WorkspacesResponse"
  | "WorkspaceResponse"
  | "WorkspaceGitRefsResponse"
  | "DeleteWorkspaceResponse"
  | "TasksResponse"
  | "TaskResponse"
  | "DeleteTaskResponse"
  | "StartTaskResponse"
  | "StopTaskResponse"
  | "TaskInputResponse"
  | "PlanTaskResponse"
  | "CleanupTaskWorktreeResponse"
  | "RunsResponse"
  | "RunLogResponse"
  | "HealthResponse";

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
  }
];
