import typia from "typia";

import type {
  ApiError,
  CreateTaskBody,
  CreateWorkspaceBody,
  CleanupTaskWorktreeParams,
  CleanupTaskWorktreeResponse,
  DeleteTaskParams,
  DeleteTaskResponse,
  DeleteWorkspaceParams,
  DeleteWorkspaceResponse,
  HealthResponse,
  ListWorkspaceGitRefsParams,
  ListRunsParams,
  ListTasksQuery,
  PlanTaskParams,
  PlanTaskResponse,
  RunLogParams,
  RunLogResponse,
  RunsResponse,
  StartTaskParams,
  StartTaskResponse,
  StopTaskParams,
  StopTaskResponse,
  TaskInputBody,
  TaskInputParams,
  TaskInputResponse,
  TaskResponse,
  TasksResponse,
  UpdateTaskBody,
  UpdateTaskParams,
  UpdateWorkspaceBody,
  UpdateWorkspaceParams,
  WorkspaceGitRefsResponse,
  WorkspaceResponse,
  WorkspacesResponse
} from "./api.js";
import type { Run, Task, TaskWorktree, Workspace, WorkspaceGitRef } from "./domain.js";

export const validateCreateWorkspaceBody =
  typia.createValidate<CreateWorkspaceBody>();
export const validateUpdateWorkspaceParams =
  typia.createValidate<UpdateWorkspaceParams>();
export const validateUpdateWorkspaceBody =
  typia.createValidate<UpdateWorkspaceBody>();
export const validateDeleteWorkspaceParams =
  typia.createValidate<DeleteWorkspaceParams>();
export const validateListWorkspaceGitRefsParams =
  typia.createValidate<ListWorkspaceGitRefsParams>();

export const validateListTasksQuery = typia.createValidate<ListTasksQuery>();
export const validateCreateTaskBody = typia.createValidate<CreateTaskBody>();
export const validateUpdateTaskParams = typia.createValidate<UpdateTaskParams>();
export const validateUpdateTaskBody = typia.createValidate<UpdateTaskBody>();
export const validateDeleteTaskParams = typia.createValidate<DeleteTaskParams>();
export const validateStartTaskParams = typia.createValidate<StartTaskParams>();
export const validateStopTaskParams = typia.createValidate<StopTaskParams>();
export const validateTaskInputParams = typia.createValidate<TaskInputParams>();
export const validateTaskInputBody = typia.createValidate<TaskInputBody>();
export const validatePlanTaskParams = typia.createValidate<PlanTaskParams>();
export const validateCleanupTaskWorktreeParams =
  typia.createValidate<CleanupTaskWorktreeParams>();
export const validateListRunsParams = typia.createValidate<ListRunsParams>();
export const validateRunLogParams = typia.createValidate<RunLogParams>();

export const schemaRegistry = {
  ApiError: () => typia.json.schema<ApiError>(),
  Workspace: () => typia.json.schema<Workspace>(),
  WorkspaceGitRef: () => typia.json.schema<WorkspaceGitRef>(),
  TaskWorktree: () => typia.json.schema<TaskWorktree>(),
  Task: () => typia.json.schema<Task>(),
  Run: () => typia.json.schema<Run>(),
  CreateWorkspaceBody: () => typia.json.schema<CreateWorkspaceBody>(),
  ListWorkspaceGitRefsParams: () => typia.json.schema<ListWorkspaceGitRefsParams>(),
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
  TaskInputParams: () => typia.json.schema<TaskInputParams>(),
  TaskInputBody: () => typia.json.schema<TaskInputBody>(),
  PlanTaskParams: () => typia.json.schema<PlanTaskParams>(),
  CleanupTaskWorktreeParams: () => typia.json.schema<CleanupTaskWorktreeParams>(),
  ListRunsParams: () => typia.json.schema<ListRunsParams>(),
  RunLogParams: () => typia.json.schema<RunLogParams>(),
  WorkspacesResponse: () => typia.json.schema<WorkspacesResponse>(),
  WorkspaceResponse: () => typia.json.schema<WorkspaceResponse>(),
  WorkspaceGitRefsResponse: () => typia.json.schema<WorkspaceGitRefsResponse>(),
  DeleteWorkspaceResponse: () => typia.json.schema<DeleteWorkspaceResponse>(),
  TasksResponse: () => typia.json.schema<TasksResponse>(),
  TaskResponse: () => typia.json.schema<TaskResponse>(),
  DeleteTaskResponse: () => typia.json.schema<DeleteTaskResponse>(),
  StartTaskResponse: () => typia.json.schema<StartTaskResponse>(),
  StopTaskResponse: () => typia.json.schema<StopTaskResponse>(),
  TaskInputResponse: () => typia.json.schema<TaskInputResponse>(),
  PlanTaskResponse: () => typia.json.schema<PlanTaskResponse>(),
  CleanupTaskWorktreeResponse: () => typia.json.schema<CleanupTaskWorktreeResponse>(),
  RunsResponse: () => typia.json.schema<RunsResponse>(),
  RunLogResponse: () => typia.json.schema<RunLogResponse>(),
  HealthResponse: () => typia.json.schema<HealthResponse>()
};
