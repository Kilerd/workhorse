import typia from "typia";

import type {
  AgentParams,
  AgentResponse,
  ApproveTaskParams,
  ApiError,
  CreateAgentBody,
  CreateTaskBody,
  CreateWorkspaceBody,
  CleanupTaskWorktreeParams,
  CleanupTaskWorktreeResponse,
  DeleteAgentResponse,
  DeleteTaskParams,
  DeleteTaskResponse,
  DeleteWorkspaceParams,
  DeleteWorkspaceResponse,
  GetTaskDependenciesParams,
  HealthResponse,
  ListAgentsResponse,
  ListWorkspaceAgentsParams,
  ListWorkspaceAgentsResponse,
  MountAgentBody,
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
  RequestTaskReviewBody,
  CreateThreadBody,
  ListThreadsParams,
  ListThreadsResponse,
  ListThreadMessagesParams,
  ListThreadMessagesQuery,
  ListThreadMessagesResponse,
  MessageResponse,
  PlanParams,
  PlanResponse,
  PostThreadMessageBody,
  PostThreadMessageParams,
  ThreadResponse,
  RequestTaskReviewResponse,
  RejectTaskBody,
  RejectTaskParams,
  SchedulerEvaluateResponse,
  SchedulerStatusResponse,
  SetTaskDependenciesBody,
  SetTaskDependenciesParams,
  TaskDependenciesResponse,
  TaskDiffParams,
  TaskDiffResponse,
  WorkspaceDiffParams,
  WorkspaceDiffResponse,
  RetryTaskParams,
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
  UpdateAgentBody,
  UpdateAgentRoleBody,
  UpdateTaskBody,
  UpdateTaskParams,
  UpdateSettingsBody,
  UpdateWorkspaceBody,
  UpdateWorkspaceParams,
  WorkspaceAgentParams,
  WorkspaceAgentResponse,
  WorkspaceGitRefsResponse,
  WorkspaceGitStatusResponse,
  WorkspaceGitPullResponse,
  WorkspaceResponse,
  WorkspacesResponse
} from "./api.js";
import type {
  AccountAgent,
  GlobalSettings,
  Message,
  Plan,
  Run,
  Task,
  TaskWorktree,
  Thread,
  Workspace,
  WorkspaceAgent,
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
export const validateApproveTaskParams =
  typia.createValidate<ApproveTaskParams>();
export const validateRejectTaskParams =
  typia.createValidate<RejectTaskParams>();
export const validateRejectTaskBody =
  typia.createValidate<RejectTaskBody>();
export const validateRetryTaskParams =
  typia.createValidate<RetryTaskParams>();
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
export const validateRequestTaskReviewBody =
  typia.createValidate<RequestTaskReviewBody>();
export const validateCleanupTaskWorktreeParams =
  typia.createValidate<CleanupTaskWorktreeParams>();
export const validateTaskDiffParams = typia.createValidate<TaskDiffParams>();
export const validateWorkspaceDiffParams = typia.createValidate<WorkspaceDiffParams>();
export const validateListRunsParams = typia.createValidate<ListRunsParams>();
export const validateRunLogParams = typia.createValidate<RunLogParams>();
export const validateSetTaskDependenciesParams =
  typia.createValidate<SetTaskDependenciesParams>();
export const validateSetTaskDependenciesBody =
  typia.createValidate<SetTaskDependenciesBody>();
export const validateGetTaskDependenciesParams =
  typia.createValidate<GetTaskDependenciesParams>();

// === Agent-driven board (Spec 02) ===

export const validateListThreadsParams =
  typia.createValidate<ListThreadsParams>();
export const validateCreateThreadBody =
  typia.createValidate<CreateThreadBody>();
export const validatePostThreadMessageParams =
  typia.createValidate<PostThreadMessageParams>();
export const validatePostThreadMessageBody =
  typia.createValidate<PostThreadMessageBody>();
export const validateListThreadMessagesParams =
  typia.createValidate<ListThreadMessagesParams>();
export const validateListThreadMessagesQuery =
  typia.createValidate<ListThreadMessagesQuery>();
export const validatePlanParams = typia.createValidate<PlanParams>();
export const validateMessage = typia.createValidate<Message>();

export const validateCreateAgentBody = typia.createValidate<CreateAgentBody>();
export const validateUpdateAgentBody = typia.createValidate<UpdateAgentBody>();
export const validateAgentParams = typia.createValidate<AgentParams>();
export const validateListWorkspaceAgentsParams =
  typia.createValidate<ListWorkspaceAgentsParams>();
export const validateMountAgentBody = typia.createValidate<MountAgentBody>();
export const validateWorkspaceAgentParams =
  typia.createValidate<WorkspaceAgentParams>();
export const validateUpdateAgentRoleBody =
  typia.createValidate<UpdateAgentRoleBody>();

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
  ApproveTaskParams: () => typia.json.schema<ApproveTaskParams>(),
  RejectTaskParams: () => typia.json.schema<RejectTaskParams>(),
  RejectTaskBody: () => typia.json.schema<RejectTaskBody>(),
  RetryTaskParams: () => typia.json.schema<RetryTaskParams>(),
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
  RequestTaskReviewBody: () => typia.json.schema<RequestTaskReviewBody>(),
  CleanupTaskWorktreeParams: () => typia.json.schema<CleanupTaskWorktreeParams>(),
  TaskDiffParams: () => typia.json.schema<TaskDiffParams>(),
  WorkspaceDiffParams: () => typia.json.schema<WorkspaceDiffParams>(),
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
  WorkspaceDiffResponse: () => typia.json.schema<WorkspaceDiffResponse>(),
  RunsResponse: () => typia.json.schema<RunsResponse>(),
  RunLogResponse: () => typia.json.schema<RunLogResponse>(),
  HealthResponse: () => typia.json.schema<HealthResponse>(),
  SetTaskDependenciesParams: () => typia.json.schema<SetTaskDependenciesParams>(),
  SetTaskDependenciesBody: () => typia.json.schema<SetTaskDependenciesBody>(),
  GetTaskDependenciesParams: () => typia.json.schema<GetTaskDependenciesParams>(),
  TaskDependenciesResponse: () => typia.json.schema<TaskDependenciesResponse>(),
  SchedulerStatusResponse: () => typia.json.schema<SchedulerStatusResponse>(),
  SchedulerEvaluateResponse: () => typia.json.schema<SchedulerEvaluateResponse>(),
  AccountAgent: () => typia.json.schema<AccountAgent>(),
  WorkspaceAgent: () => typia.json.schema<WorkspaceAgent>(),
  CreateAgentBody: () => typia.json.schema<CreateAgentBody>(),
  UpdateAgentBody: () => typia.json.schema<UpdateAgentBody>(),
  AgentParams: () => typia.json.schema<AgentParams>(),
  ListWorkspaceAgentsParams: () => typia.json.schema<ListWorkspaceAgentsParams>(),
  MountAgentBody: () => typia.json.schema<MountAgentBody>(),
  WorkspaceAgentParams: () => typia.json.schema<WorkspaceAgentParams>(),
  UpdateAgentRoleBody: () => typia.json.schema<UpdateAgentRoleBody>(),
  AgentResponse: () => typia.json.schema<AgentResponse>(),
  ListAgentsResponse: () => typia.json.schema<ListAgentsResponse>(),
  DeleteAgentResponse: () => typia.json.schema<DeleteAgentResponse>(),
  WorkspaceAgentResponse: () => typia.json.schema<WorkspaceAgentResponse>(),
  ListWorkspaceAgentsResponse: () => typia.json.schema<ListWorkspaceAgentsResponse>(),
  Thread: () => typia.json.schema<Thread>(),
  Message: () => typia.json.schema<Message>(),
  Plan: () => typia.json.schema<Plan>(),
  ListThreadsParams: () => typia.json.schema<ListThreadsParams>(),
  CreateThreadBody: () => typia.json.schema<CreateThreadBody>(),
  PostThreadMessageParams: () => typia.json.schema<PostThreadMessageParams>(),
  PostThreadMessageBody: () => typia.json.schema<PostThreadMessageBody>(),
  ListThreadMessagesParams: () => typia.json.schema<ListThreadMessagesParams>(),
  ListThreadMessagesQuery: () => typia.json.schema<ListThreadMessagesQuery>(),
  PlanParams: () => typia.json.schema<PlanParams>(),
  ListThreadsResponse: () => typia.json.schema<ListThreadsResponse>(),
  ThreadResponse: () => typia.json.schema<ThreadResponse>(),
  ListThreadMessagesResponse: () => typia.json.schema<ListThreadMessagesResponse>(),
  MessageResponse: () => typia.json.schema<MessageResponse>(),
  PlanResponse: () => typia.json.schema<PlanResponse>()
};
