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
  PickWorkspaceRootResponse,
  ListWorkspaceGitRefsParams,
  WorkspaceGitStatusParams,
  WorkspaceGitPullParams,
  ListRunsParams,
  ListTasksQuery,
  PlanFeedbackBody,
  PlanFeedbackParams,
  PlanFeedbackResponse,
  PlanTaskParams,
  PlanTaskResponse,
  RequestTaskReviewParams,
  RequestTaskReviewResponse,
  TaskDiffParams,
  TaskDiffResponse,
  RunLogParams,
  RunLogResponse,
  RunsResponse,
  SettingsResponse,
  StartTaskBody,
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
  UpdateSettingsBody,
  UpdateWorkspaceBody,
  UpdateWorkspaceParams,
  WorkspaceGitRefsResponse,
  WorkspaceGitStatusResponse,
  WorkspaceGitPullResponse,
  WorkspaceResponse,
  WorkspacesResponse
} from "./api.js";
import type {
  GlobalSettings,
  Run,
  Task,
  TaskWorktree,
  Workspace,
  WorkspaceGitRef
} from "./domain.js";

export const validateUpdateSettingsBody =
  typia.createValidate<UpdateSettingsBody>();
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
export const validateWorkspaceGitStatusParams =
  typia.createValidate<WorkspaceGitStatusParams>();
export const validateWorkspaceGitPullParams =
  typia.createValidate<WorkspaceGitPullParams>();

export const validateListTasksQuery = typia.createValidate<ListTasksQuery>();
export const validateCreateTaskBody = typia.createValidate<CreateTaskBody>();
export const validateUpdateTaskParams = typia.createValidate<UpdateTaskParams>();
export const validateUpdateTaskBody = typia.createValidate<UpdateTaskBody>();
export const validateDeleteTaskParams = typia.createValidate<DeleteTaskParams>();
export const validateStartTaskParams = typia.createValidate<StartTaskParams>();
export const validateStartTaskBody = typia.createValidate<StartTaskBody>();
export const validateStopTaskParams = typia.createValidate<StopTaskParams>();
export const validateTaskInputParams = typia.createValidate<TaskInputParams>();
export const validateTaskInputBody = typia.createValidate<TaskInputBody>();
export const validatePlanTaskParams = typia.createValidate<PlanTaskParams>();
export const validatePlanFeedbackParams = typia.createValidate<PlanFeedbackParams>();
export const validatePlanFeedbackBody = typia.createValidate<PlanFeedbackBody>();
export const validateRequestTaskReviewParams =
  typia.createValidate<RequestTaskReviewParams>();
export const validateCleanupTaskWorktreeParams =
  typia.createValidate<CleanupTaskWorktreeParams>();
export const validateTaskDiffParams = typia.createValidate<TaskDiffParams>();
export const validateListRunsParams = typia.createValidate<ListRunsParams>();
export const validateRunLogParams = typia.createValidate<RunLogParams>();

export const schemaRegistry = {
  ApiError: () => typia.json.schema<ApiError>(),
  GlobalSettings: () => typia.json.schema<GlobalSettings>(),
  Workspace: () => typia.json.schema<Workspace>(),
  WorkspaceGitRef: () => typia.json.schema<WorkspaceGitRef>(),
  TaskWorktree: () => typia.json.schema<TaskWorktree>(),
  Task: () => typia.json.schema<Task>(),
  Run: () => typia.json.schema<Run>(),
  UpdateSettingsBody: () => typia.json.schema<UpdateSettingsBody>(),
  CreateWorkspaceBody: () => typia.json.schema<CreateWorkspaceBody>(),
  ListWorkspaceGitRefsParams: () => typia.json.schema<ListWorkspaceGitRefsParams>(),
  WorkspaceGitStatusParams: () => typia.json.schema<WorkspaceGitStatusParams>(),
  WorkspaceGitPullParams: () => typia.json.schema<WorkspaceGitPullParams>(),
  UpdateWorkspaceBody: () => typia.json.schema<UpdateWorkspaceBody>(),
  UpdateWorkspaceParams: () => typia.json.schema<UpdateWorkspaceParams>(),
  DeleteWorkspaceParams: () => typia.json.schema<DeleteWorkspaceParams>(),
  ListTasksQuery: () => typia.json.schema<ListTasksQuery>(),
  CreateTaskBody: () => typia.json.schema<CreateTaskBody>(),
  UpdateTaskParams: () => typia.json.schema<UpdateTaskParams>(),
  UpdateTaskBody: () => typia.json.schema<UpdateTaskBody>(),
  DeleteTaskParams: () => typia.json.schema<DeleteTaskParams>(),
  StartTaskParams: () => typia.json.schema<StartTaskParams>(),
  StartTaskBody: () => typia.json.schema<StartTaskBody>(),
  StopTaskParams: () => typia.json.schema<StopTaskParams>(),
  TaskInputParams: () => typia.json.schema<TaskInputParams>(),
  TaskInputBody: () => typia.json.schema<TaskInputBody>(),
  PlanTaskParams: () => typia.json.schema<PlanTaskParams>(),
  PlanFeedbackParams: () => typia.json.schema<PlanFeedbackParams>(),
  PlanFeedbackBody: () => typia.json.schema<PlanFeedbackBody>(),
  RequestTaskReviewParams: () => typia.json.schema<RequestTaskReviewParams>(),
  CleanupTaskWorktreeParams: () => typia.json.schema<CleanupTaskWorktreeParams>(),
  TaskDiffParams: () => typia.json.schema<TaskDiffParams>(),
  ListRunsParams: () => typia.json.schema<ListRunsParams>(),
  RunLogParams: () => typia.json.schema<RunLogParams>(),
  SettingsResponse: () => typia.json.schema<SettingsResponse>(),
  WorkspacesResponse: () => typia.json.schema<WorkspacesResponse>(),
  WorkspaceResponse: () => typia.json.schema<WorkspaceResponse>(),
  WorkspaceGitRefsResponse: () => typia.json.schema<WorkspaceGitRefsResponse>(),
  WorkspaceGitStatusResponse: () => typia.json.schema<WorkspaceGitStatusResponse>(),
  WorkspaceGitPullResponse: () => typia.json.schema<WorkspaceGitPullResponse>(),
  PickWorkspaceRootResponse: () => typia.json.schema<PickWorkspaceRootResponse>(),
  DeleteWorkspaceResponse: () => typia.json.schema<DeleteWorkspaceResponse>(),
  TasksResponse: () => typia.json.schema<TasksResponse>(),
  TaskResponse: () => typia.json.schema<TaskResponse>(),
  DeleteTaskResponse: () => typia.json.schema<DeleteTaskResponse>(),
  StartTaskResponse: () => typia.json.schema<StartTaskResponse>(),
  StopTaskResponse: () => typia.json.schema<StopTaskResponse>(),
  TaskInputResponse: () => typia.json.schema<TaskInputResponse>(),
  PlanTaskResponse: () => typia.json.schema<PlanTaskResponse>(),
  PlanFeedbackResponse: () => typia.json.schema<PlanFeedbackResponse>(),
  RequestTaskReviewResponse: () => typia.json.schema<RequestTaskReviewResponse>(),
  CleanupTaskWorktreeResponse: () => typia.json.schema<CleanupTaskWorktreeResponse>(),
  TaskDiffResponse: () => typia.json.schema<TaskDiffResponse>(),
  RunsResponse: () => typia.json.schema<RunsResponse>(),
  RunLogResponse: () => typia.json.schema<RunLogResponse>(),
  HealthResponse: () => typia.json.schema<HealthResponse>()
};
