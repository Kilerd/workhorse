import typia from "typia";

import type {
  ApiError,
  CreateTaskBody,
  CreateWorkspaceBody,
  DeleteTaskParams,
  DeleteTaskResponse,
  DeleteWorkspaceParams,
  DeleteWorkspaceResponse,
  HealthResponse,
  ListRunsParams,
  ListTasksQuery,
  RunLogParams,
  RunLogResponse,
  RunsResponse,
  StartTaskParams,
  StartTaskResponse,
  StopTaskParams,
  StopTaskResponse,
  TaskResponse,
  TasksResponse,
  UpdateTaskBody,
  UpdateTaskParams,
  UpdateWorkspaceBody,
  UpdateWorkspaceParams,
  WorkspaceResponse,
  WorkspacesResponse
} from "./api.js";
import type { Run, Task, Workspace } from "./domain.js";

export const validateCreateWorkspaceBody =
  typia.createValidate<CreateWorkspaceBody>();
export const validateUpdateWorkspaceParams =
  typia.createValidate<UpdateWorkspaceParams>();
export const validateUpdateWorkspaceBody =
  typia.createValidate<UpdateWorkspaceBody>();
export const validateDeleteWorkspaceParams =
  typia.createValidate<DeleteWorkspaceParams>();

export const validateListTasksQuery = typia.createValidate<ListTasksQuery>();
export const validateCreateTaskBody = typia.createValidate<CreateTaskBody>();
export const validateUpdateTaskParams = typia.createValidate<UpdateTaskParams>();
export const validateUpdateTaskBody = typia.createValidate<UpdateTaskBody>();
export const validateDeleteTaskParams = typia.createValidate<DeleteTaskParams>();
export const validateStartTaskParams = typia.createValidate<StartTaskParams>();
export const validateStopTaskParams = typia.createValidate<StopTaskParams>();
export const validateListRunsParams = typia.createValidate<ListRunsParams>();
export const validateRunLogParams = typia.createValidate<RunLogParams>();

export const schemaRegistry = {
  ApiError: () => typia.json.schema<ApiError>(),
  Workspace: () => typia.json.schema<Workspace>(),
  Task: () => typia.json.schema<Task>(),
  Run: () => typia.json.schema<Run>(),
  CreateWorkspaceBody: () => typia.json.schema<CreateWorkspaceBody>(),
  UpdateWorkspaceBody: () => typia.json.schema<UpdateWorkspaceBody>(),
  UpdateWorkspaceParams: () => typia.json.schema<UpdateWorkspaceParams>(),
  DeleteWorkspaceParams: () => typia.json.schema<DeleteWorkspaceParams>(),
  ListTasksQuery: () => typia.json.schema<ListTasksQuery>(),
  CreateTaskBody: () => typia.json.schema<CreateTaskBody>(),
  UpdateTaskParams: () => typia.json.schema<UpdateTaskParams>(),
  UpdateTaskBody: () => typia.json.schema<UpdateTaskBody>(),
  DeleteTaskParams: () => typia.json.schema<DeleteTaskParams>(),
  StartTaskParams: () => typia.json.schema<StartTaskParams>(),
  StopTaskParams: () => typia.json.schema<StopTaskParams>(),
  ListRunsParams: () => typia.json.schema<ListRunsParams>(),
  RunLogParams: () => typia.json.schema<RunLogParams>(),
  WorkspacesResponse: () => typia.json.schema<WorkspacesResponse>(),
  WorkspaceResponse: () => typia.json.schema<WorkspaceResponse>(),
  DeleteWorkspaceResponse: () => typia.json.schema<DeleteWorkspaceResponse>(),
  TasksResponse: () => typia.json.schema<TasksResponse>(),
  TaskResponse: () => typia.json.schema<TaskResponse>(),
  DeleteTaskResponse: () => typia.json.schema<DeleteTaskResponse>(),
  StartTaskResponse: () => typia.json.schema<StartTaskResponse>(),
  StopTaskResponse: () => typia.json.schema<StopTaskResponse>(),
  RunsResponse: () => typia.json.schema<RunsResponse>(),
  RunLogResponse: () => typia.json.schema<RunLogResponse>(),
  HealthResponse: () => typia.json.schema<HealthResponse>()
};
