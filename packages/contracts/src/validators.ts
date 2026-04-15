import typia from "typia";

import type {
  AgentData,
  AgentParams,
  AgentResponse,
  AgentTeamResponse,
  ApproveTaskParams,
  ApiError,
  ApproveProposalParams,
  CancelSubtaskParams,
  CreateAgentBody,
  CreateTaskBody,
  CreateTeamBody,
  CreateWorkspaceBody,
  CleanupTaskWorktreeParams,
  CleanupTaskWorktreeResponse,
  DeleteAgentResponse,
  DeleteTaskParams,
  DeleteTaskResponse,
  DeleteTeamParams,
  DeleteTeamResponse,
  DeleteWorkspaceParams,
  DeleteWorkspaceResponse,
  GetProposalParams,
  GetTaskDependenciesParams,
  GetTeamParams,
  HealthResponse,
  ListAgentsData,
  ListAgentsResponse,
  ListProposalsParams,
  ListProposalsQuery,
  ListTaskMessagesParams,
  ListTaskMessagesQuery,
  ListTeamMessagesQuery,
  ListTeamMessagesParams,
  ListTeamsQuery,
  ListWorkspaceAgentsData,
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
  PostTaskMessageBody,
  PostTaskMessageParams,
  PostTeamMessageBody,
  PostTeamMessageParams,
  PlanTaskParams,
  PlanTaskResponse,
  RejectProposalParams,
  RequestTaskReviewParams,
  WorkspaceListProposalsParams,
  WorkspaceGetProposalParams,
  WorkspaceApproveProposalParams,
  WorkspaceRejectProposalParams,
  WorkspaceCancelSubtaskParams,
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
  TaskMessageData,
  TaskMessageResponse,
  TaskMessagesData,
  TaskMessagesResponse,
  TeamMessagesResponse,
  TeamMessageResponse,
  TeamsResponse,
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
  UpdateTeamBody,
  UpdateTeamParams,
  UpdateWorkspaceBody,
  UpdateWorkspaceConfigBody,
  UpdateWorkspaceConfigParams,
  UpdateWorkspaceParams,
  WorkspaceAgentData,
  WorkspaceAgentParams,
  WorkspaceAgentResponse,
  WorkspaceGitRefsResponse,
  WorkspaceGitStatusResponse,
  WorkspaceGitPullResponse,
  WorkspaceResponse,
  WorkspacesResponse,
  ListProposalsResponse,
  ProposalResponse
} from "./api.js";
import type {
  AccountAgent,
  AgentTeam,
  GlobalSettings,
  Run,
  Task,
  TaskMessage,
  TaskWorktree,
  TeamMessage,
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
export const validateCancelSubtaskParams =
  typia.createValidate<CancelSubtaskParams>();
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
export const validateSetTaskDependenciesParams =
  typia.createValidate<SetTaskDependenciesParams>();
export const validateSetTaskDependenciesBody =
  typia.createValidate<SetTaskDependenciesBody>();
export const validateGetTaskDependenciesParams =
  typia.createValidate<GetTaskDependenciesParams>();

export const validateListTeamsQuery = typia.createValidate<ListTeamsQuery>();
export const validateCreateTeamBody = typia.createValidate<CreateTeamBody>();
export const validateUpdateTeamParams = typia.createValidate<UpdateTeamParams>();
export const validateUpdateTeamBody = typia.createValidate<UpdateTeamBody>();
export const validateGetTeamParams = typia.createValidate<GetTeamParams>();
export const validateDeleteTeamParams = typia.createValidate<DeleteTeamParams>();
export const validateListTeamMessagesParams =
  typia.createValidate<ListTeamMessagesParams>();
export const validateListTeamMessagesQuery =
  typia.createValidate<ListTeamMessagesQuery>();
export const validatePostTeamMessageParams =
  typia.createValidate<PostTeamMessageParams>();
export const validatePostTeamMessageBody =
  typia.createValidate<PostTeamMessageBody>();

export const validateListProposalsParams =
  typia.createValidate<ListProposalsParams>();
export const validateListProposalsQuery =
  typia.createValidate<ListProposalsQuery>();
export const validateGetProposalParams =
  typia.createValidate<GetProposalParams>();
export const validateApproveProposalParams =
  typia.createValidate<ApproveProposalParams>();
export const validateRejectProposalParams =
  typia.createValidate<RejectProposalParams>();

export const validateWorkspaceListProposalsParams =
  typia.createValidate<WorkspaceListProposalsParams>();
export const validateWorkspaceGetProposalParams =
  typia.createValidate<WorkspaceGetProposalParams>();
export const validateWorkspaceApproveProposalParams =
  typia.createValidate<WorkspaceApproveProposalParams>();
export const validateWorkspaceRejectProposalParams =
  typia.createValidate<WorkspaceRejectProposalParams>();
export const validateWorkspaceCancelSubtaskParams =
  typia.createValidate<WorkspaceCancelSubtaskParams>();

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
export const validateUpdateWorkspaceConfigBody =
  typia.createValidate<UpdateWorkspaceConfigBody>();
export const validateUpdateWorkspaceConfigParams =
  typia.createValidate<UpdateWorkspaceConfigParams>();
export const validateListTaskMessagesParams =
  typia.createValidate<ListTaskMessagesParams>();
export const validateListTaskMessagesQuery =
  typia.createValidate<ListTaskMessagesQuery>();
export const validatePostTaskMessageBody =
  typia.createValidate<PostTaskMessageBody>();
export const validatePostTaskMessageParams =
  typia.createValidate<PostTaskMessageParams>();

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
  CancelSubtaskParams: () => typia.json.schema<CancelSubtaskParams>(),
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
  HealthResponse: () => typia.json.schema<HealthResponse>(),
  SetTaskDependenciesParams: () => typia.json.schema<SetTaskDependenciesParams>(),
  SetTaskDependenciesBody: () => typia.json.schema<SetTaskDependenciesBody>(),
  GetTaskDependenciesParams: () => typia.json.schema<GetTaskDependenciesParams>(),
  TaskDependenciesResponse: () => typia.json.schema<TaskDependenciesResponse>(),
  SchedulerStatusResponse: () => typia.json.schema<SchedulerStatusResponse>(),
  SchedulerEvaluateResponse: () => typia.json.schema<SchedulerEvaluateResponse>(),
  AgentTeam: () => typia.json.schema<AgentTeam>(),
  TeamMessage: () => typia.json.schema<TeamMessage>(),
  CreateTeamBody: () => typia.json.schema<CreateTeamBody>(),
  UpdateTeamParams: () => typia.json.schema<UpdateTeamParams>(),
  UpdateTeamBody: () => typia.json.schema<UpdateTeamBody>(),
  GetTeamParams: () => typia.json.schema<GetTeamParams>(),
  DeleteTeamParams: () => typia.json.schema<DeleteTeamParams>(),
  ListTeamMessagesParams: () => typia.json.schema<ListTeamMessagesParams>(),
  ListTeamMessagesQuery: () => typia.json.schema<ListTeamMessagesQuery>(),
  PostTeamMessageParams: () => typia.json.schema<PostTeamMessageParams>(),
  PostTeamMessageBody: () => typia.json.schema<PostTeamMessageBody>(),
  ListTeamsQuery: () => typia.json.schema<ListTeamsQuery>(),
  TeamsResponse: () => typia.json.schema<TeamsResponse>(),
  AgentTeamResponse: () => typia.json.schema<AgentTeamResponse>(),
  DeleteTeamResponse: () => typia.json.schema<DeleteTeamResponse>(),
  TeamMessagesResponse: () => typia.json.schema<TeamMessagesResponse>(),
  TeamMessageResponse: () => typia.json.schema<TeamMessageResponse>(),
  AccountAgent: () => typia.json.schema<AccountAgent>(),
  WorkspaceAgent: () => typia.json.schema<WorkspaceAgent>(),
  TaskMessage: () => typia.json.schema<TaskMessage>(),
  CreateAgentBody: () => typia.json.schema<CreateAgentBody>(),
  UpdateAgentBody: () => typia.json.schema<UpdateAgentBody>(),
  AgentParams: () => typia.json.schema<AgentParams>(),
  ListWorkspaceAgentsParams: () => typia.json.schema<ListWorkspaceAgentsParams>(),
  MountAgentBody: () => typia.json.schema<MountAgentBody>(),
  WorkspaceAgentParams: () => typia.json.schema<WorkspaceAgentParams>(),
  UpdateAgentRoleBody: () => typia.json.schema<UpdateAgentRoleBody>(),
  UpdateWorkspaceConfigBody: () => typia.json.schema<UpdateWorkspaceConfigBody>(),
  UpdateWorkspaceConfigParams: () => typia.json.schema<UpdateWorkspaceConfigParams>(),
  ListTaskMessagesParams: () => typia.json.schema<ListTaskMessagesParams>(),
  ListTaskMessagesQuery: () => typia.json.schema<ListTaskMessagesQuery>(),
  PostTaskMessageBody: () => typia.json.schema<PostTaskMessageBody>(),
  PostTaskMessageParams: () => typia.json.schema<PostTaskMessageParams>(),
  AgentResponse: () => typia.json.schema<AgentResponse>(),
  ListAgentsResponse: () => typia.json.schema<ListAgentsResponse>(),
  DeleteAgentResponse: () => typia.json.schema<DeleteAgentResponse>(),
  WorkspaceAgentResponse: () => typia.json.schema<WorkspaceAgentResponse>(),
  ListWorkspaceAgentsResponse: () => typia.json.schema<ListWorkspaceAgentsResponse>(),
  TaskMessagesResponse: () => typia.json.schema<TaskMessagesResponse>(),
  TaskMessageResponse: () => typia.json.schema<TaskMessageResponse>(),
  WorkspaceListProposalsParams: () => typia.json.schema<WorkspaceListProposalsParams>(),
  WorkspaceGetProposalParams: () => typia.json.schema<WorkspaceGetProposalParams>(),
  WorkspaceApproveProposalParams: () => typia.json.schema<WorkspaceApproveProposalParams>(),
  WorkspaceRejectProposalParams: () => typia.json.schema<WorkspaceRejectProposalParams>(),
  WorkspaceCancelSubtaskParams: () => typia.json.schema<WorkspaceCancelSubtaskParams>(),
  ListProposalsResponse: () => typia.json.schema<ListProposalsResponse>(),
  ProposalResponse: () => typia.json.schema<ProposalResponse>(),
  ListProposalsQuery: () => typia.json.schema<ListProposalsQuery>()
};
