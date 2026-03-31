import { Fetcher, type Middleware } from "openapi-typescript-fetch";

import type {
  CreateTaskBody,
  CreateWorkspaceBody,
  DeleteTaskResponse,
  DeleteWorkspaceResponse,
  HealthResponse,
  RunLogResponse,
  RunsResponse,
  StartTaskResponse,
  StopTaskResponse,
  TaskResponse,
  TasksResponse,
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
  const listRuns = fetcher
    .path("/api/tasks/{taskId}/runs")
    .method("get")
    .create();
  const getRunLog = fetcher
    .path("/api/runs/{runId}/log")
    .method("get")
    .create();
  const health = fetcher.path("/api/health").method("get").create();

  return {
    health: async (): Promise<HealthResponse> => (await health({})).data,
    listWorkspaces: async (): Promise<WorkspacesResponse> =>
      (await listWorkspaces({})).data,
    createWorkspace: async (body: CreateWorkspaceBody): Promise<WorkspaceResponse> =>
      (await createWorkspace(body)).data,
    updateWorkspace: async (
      workspaceId: string,
      body: UpdateWorkspaceBody
    ): Promise<WorkspaceResponse> =>
      (await updateWorkspace({ workspaceId, ...body })).data,
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
    startTask: async (taskId: string): Promise<StartTaskResponse> =>
      (await startTask({ taskId })).data,
    stopTask: async (taskId: string): Promise<StopTaskResponse> =>
      (await stopTask({ taskId })).data,
    listRuns: async (taskId: string): Promise<RunsResponse> =>
      (await listRuns({ taskId })).data,
    getRunLog: async (runId: string): Promise<RunLogResponse> =>
      (await getRunLog({ runId })).data
  };
}

export type { paths } from "./generated/openapi";
