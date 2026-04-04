import { Fetcher, type Middleware } from "openapi-typescript-fetch";

import type {
  CleanupTaskWorktreeData,
  CreateTaskBody,
  CreateWorkspaceBody,
  DeleteResult,
  HealthData,
  ListRunsData,
  ListTasksData,
  ListWorkspacesData,
  PickWorkspaceRootData,
  PlanFeedbackBody,
  PlanFeedbackData,
  PlanTaskData,
  RequestTaskReviewData,
  RunLogData,
  SettingsData,
  StartTaskBody,
  StartTaskData,
  StopTaskData,
  TaskData,
  TaskDiffData,
  TaskInputBody,
  TaskInputData,
  UpdateSettingsBody,
  UpdateTaskBody,
  UpdateWorkspaceBody,
  WorkspaceData,
  WorkspaceGitRefsData
} from "@workhorse/contracts";
import type { paths } from "./generated/openapi";

const jsonHeaders = {
  "content-type": "application/json"
};

const errorMiddleware: Middleware = async (url, init, next) => {
  const response = await next(url, init);
  return response;
};

function resolveRequestUrl(baseUrl: string, path: string): string {
  if (!baseUrl) {
    return path;
  }

  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export function createApiClient(baseUrl: string) {
  const fetcher = Fetcher.for<paths>();
  fetcher.configure({
    baseUrl,
    init: {
      headers: jsonHeaders
    },
    use: [errorMiddleware]
  });

  const listWorkspaces = fetcher.path("/api/workspaces").method("get").create();
  const pickWorkspaceRoot = fetcher
    .path("/api/workspaces/pick-root")
    .method("post")
    .create();
  const createWorkspace = fetcher.path("/api/workspaces").method("post").create();
  const updateWorkspace = fetcher
    .path("/api/workspaces/{workspaceId}")
    .method("patch")
    .create();
  const listWorkspaceGitRefs = fetcher
    .path("/api/workspaces/{workspaceId}/git/refs")
    .method("get")
    .create();
  const deleteWorkspace = fetcher
    .path("/api/workspaces/{workspaceId}")
    .method("delete")
    .create();

  const listTasks = fetcher.path("/api/tasks").method("get").create();
  const createTask = fetcher.path("/api/tasks").method("post").create();
  const updateTask = fetcher.path("/api/tasks/{taskId}").method("patch").create();
  const deleteTask = fetcher
    .path("/api/tasks/{taskId}")
    .method("delete")
    .create();
  const startTask = fetcher
    .path("/api/tasks/{taskId}/start")
    .method("post")
    .create();
  const stopTask = fetcher
    .path("/api/tasks/{taskId}/stop")
    .method("post")
    .create();
  const sendTaskInput = fetcher
    .path("/api/tasks/{taskId}/input")
    .method("post")
    .create();
  const planTask = fetcher
    .path("/api/tasks/{taskId}/plan")
    .method("post")
    .create();
  const sendPlanFeedback = fetcher
    .path("/api/tasks/{taskId}/plan-feedback")
    .method("post")
    .create();
  const requestTaskReview = fetcher
    .path("/api/tasks/{taskId}/review-request")
    .method("post")
    .create();
  const cleanupTaskWorktree = fetcher
    .path("/api/tasks/{taskId}/worktree/cleanup")
    .method("post")
    .create();
  const getTaskDiff = fetcher
    .path("/api/tasks/{taskId}/diff")
    .method("get")
    .create();
  const listRuns = fetcher
    .path("/api/tasks/{taskId}/runs")
    .method("get")
    .create();
  const getRunLog = fetcher
    .path("/api/runs/{runId}/log")
    .method("get")
    .create();
  const health = fetcher.path("/api/health").method("get").create();

  async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(resolveRequestUrl(baseUrl, path), {
      ...init,
      headers: {
        ...jsonHeaders,
        ...(init?.headers ?? {})
      }
    });
    const payload = (await response.json()) as T;
    if (!response.ok) {
      throw Object.assign(new Error(response.statusText), {
        data: payload,
        status: response.status
      });
    }
    return payload;
  }

  function unwrap<T>(response: { ok: true; data: T }): T {
    return response.data;
  }

  return {
    health: async (): Promise<HealthData> => unwrap((await health({})).data),
    getSettings: async (): Promise<SettingsData> =>
      unwrap(await requestJson("/api/settings")),
    updateSettings: async (body: UpdateSettingsBody): Promise<SettingsData> =>
      unwrap(
        await requestJson("/api/settings", {
          method: "PATCH",
          body: JSON.stringify(body)
        })
      ),
    listWorkspaces: async (): Promise<ListWorkspacesData> =>
      unwrap((await listWorkspaces({})).data),
    pickWorkspaceRoot: async (): Promise<PickWorkspaceRootData> =>
      unwrap((await pickWorkspaceRoot({})).data),
    createWorkspace: async (body: CreateWorkspaceBody): Promise<WorkspaceData> =>
      unwrap((await createWorkspace(body)).data),
    updateWorkspace: async (
      workspaceId: string,
      body: UpdateWorkspaceBody
    ): Promise<WorkspaceData> =>
      unwrap((await updateWorkspace({ workspaceId, ...body })).data),
    listWorkspaceGitRefs: async (
      workspaceId: string
    ): Promise<WorkspaceGitRefsData> =>
      unwrap((await listWorkspaceGitRefs({ workspaceId })).data),
    deleteWorkspace: async (workspaceId: string): Promise<DeleteResult> =>
      unwrap((await deleteWorkspace({ workspaceId })).data),
    listTasks: async (workspaceId?: string): Promise<ListTasksData> =>
      unwrap((await listTasks(workspaceId ? { workspaceId } : {})).data),
    createTask: async (body: CreateTaskBody): Promise<TaskData> =>
      unwrap((await createTask(body)).data),
    updateTask: async (
      taskId: string,
      body: UpdateTaskBody
    ): Promise<TaskData> =>
      unwrap((await updateTask({ taskId, ...body })).data),
    deleteTask: async (taskId: string): Promise<DeleteResult> =>
      unwrap((await deleteTask({ taskId })).data),
    startTask: async (
      taskId: string,
      body: StartTaskBody = {}
    ): Promise<StartTaskData> =>
      unwrap((await startTask({ taskId, ...body })).data),
    stopTask: async (taskId: string): Promise<StopTaskData> =>
      unwrap((await stopTask({ taskId })).data),
    sendTaskInput: async (
      taskId: string,
      body: TaskInputBody
    ): Promise<TaskInputData> =>
      unwrap((await sendTaskInput({ taskId, ...body })).data),
    planTask: async (taskId: string): Promise<PlanTaskData> =>
      unwrap((await planTask({ taskId })).data),
    sendPlanFeedback: async (
      taskId: string,
      body: PlanFeedbackBody
    ): Promise<PlanFeedbackData> =>
      unwrap((await sendPlanFeedback({ taskId, ...body })).data),
    requestTaskReview: async (
      taskId: string
    ): Promise<RequestTaskReviewData> =>
      unwrap((await requestTaskReview({ taskId })).data),
    cleanupTaskWorktree: async (
      taskId: string
    ): Promise<CleanupTaskWorktreeData> =>
      unwrap((await cleanupTaskWorktree({ taskId })).data),
    getTaskDiff: async (taskId: string): Promise<TaskDiffData> =>
      unwrap((await getTaskDiff({ taskId })).data),
    listRuns: async (taskId: string): Promise<ListRunsData> =>
      unwrap((await listRuns({ taskId })).data),
    getRunLog: async (runId: string): Promise<RunLogData> =>
      unwrap((await getRunLog({ runId })).data)
  };
}

export type { paths } from "./generated/openapi";
