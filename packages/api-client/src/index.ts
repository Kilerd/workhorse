import { Fetcher, type Middleware } from "openapi-typescript-fetch";

import type {
  CleanupTaskWorktreeResponse,
  CreateTaskBody,
  CreateWorkspaceBody,
  DeleteTaskResponse,
  DeleteWorkspaceResponse,
  HealthResponse,
  SettingsResponse,
  WorkspaceGitRefsResponse,
  PlanTaskResponse,
  RunLogResponse,
  RunsResponse,
  StartTaskResponse,
  StartTaskBody,
  StopTaskResponse,
  TaskInputBody,
  TaskInputResponse,
  TaskResponse,
  TasksResponse,
  UpdateSettingsBody,
  UpdateTaskBody,
  UpdateWorkspaceBody,
  WorkspaceResponse,
  WorkspacesResponse
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
  const cleanupTaskWorktree = fetcher
    .path("/api/tasks/{taskId}/worktree/cleanup")
    .method("post")
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

  return {
    health: async (): Promise<HealthResponse> => (await health({})).data,
    getSettings: async (): Promise<SettingsResponse> => requestJson("/api/settings"),
    updateSettings: async (body: UpdateSettingsBody): Promise<SettingsResponse> =>
      requestJson("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    listWorkspaces: async (): Promise<WorkspacesResponse> =>
      (await listWorkspaces({})).data,
    createWorkspace: async (body: CreateWorkspaceBody): Promise<WorkspaceResponse> =>
      (await createWorkspace(body)).data,
    updateWorkspace: async (
      workspaceId: string,
      body: UpdateWorkspaceBody
    ): Promise<WorkspaceResponse> =>
      (await updateWorkspace({ workspaceId, ...body })).data,
    listWorkspaceGitRefs: async (
      workspaceId: string
    ): Promise<WorkspaceGitRefsResponse> =>
      (await listWorkspaceGitRefs({ workspaceId })).data,
    deleteWorkspace: async (
      workspaceId: string
    ): Promise<DeleteWorkspaceResponse> =>
      (await deleteWorkspace({ workspaceId })).data,
    listTasks: async (workspaceId?: string): Promise<TasksResponse> =>
      (await listTasks(workspaceId ? { workspaceId } : {})).data,
    createTask: async (body: CreateTaskBody): Promise<TaskResponse> =>
      (await createTask(body)).data,
    updateTask: async (
      taskId: string,
      body: UpdateTaskBody
    ): Promise<TaskResponse> =>
      (await updateTask({ taskId, ...body })).data,
    deleteTask: async (taskId: string): Promise<DeleteTaskResponse> =>
      (await deleteTask({ taskId })).data,
    startTask: async (
      taskId: string,
      body: StartTaskBody = {}
    ): Promise<StartTaskResponse> =>
      (await startTask({ taskId, ...body })).data,
    stopTask: async (taskId: string): Promise<StopTaskResponse> =>
      (await stopTask({ taskId })).data,
    sendTaskInput: async (
      taskId: string,
      body: TaskInputBody
    ): Promise<TaskInputResponse> =>
      (await sendTaskInput({ taskId, ...body })).data,
    planTask: async (taskId: string): Promise<PlanTaskResponse> =>
      (await planTask({ taskId })).data,
    cleanupTaskWorktree: async (
      taskId: string
    ): Promise<CleanupTaskWorktreeResponse> =>
      (await cleanupTaskWorktree({ taskId })).data,
    listRuns: async (taskId: string): Promise<RunsResponse> =>
      (await listRuns({ taskId })).data,
    getRunLog: async (runId: string): Promise<RunLogResponse> =>
      (await getRunLog({ runId })).data
  };
}

export type { paths } from "./generated/openapi";
