import { Fetcher, type Middleware } from "openapi-typescript-fetch";

import type {
  AgentTeamData,
  CleanupTaskWorktreeData,
  CoordinatorProposal,
  CreateTeamBody,
  CreateTaskBody,
  CreateWorkspaceBody,
  DeleteResult,
  GetTeamParams,
  HealthData,
  ListProposalsQuery,
  TeamMessagesData,
  ListTeamMessagesQuery,
  ListTeamsData,
  ListRunsData,
  ListTasksData,
  ListWorkspacesData,
  PickWorkspaceRootData,
  PlanFeedbackBody,
  PlanFeedbackData,
  PlanTaskData,
  PostTeamMessageBody,
  RejectTaskBody,
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
  TeamMessageData,
  UpdateTeamBody,
  UpdateSettingsBody,
  UpdateTaskBody,
  UpdateWorkspaceBody,
  WorkspaceData,
  WorkspaceGitRefsData,
  WorkspaceGitStatusData,
  WorkspaceGitPullData
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
  const listTeams = fetcher.path("/api/teams").method("get").create();
  const createTeam = fetcher.path("/api/teams").method("post").create();
  const getTeam = fetcher.path("/api/teams/{teamId}").method("get").create();
  const updateTeam = fetcher
    .path("/api/teams/{teamId}")
    .method("patch")
    .create();
  const deleteTeam = fetcher
    .path("/api/teams/{teamId}")
    .method("delete")
    .create();
  const listTeamMessages = fetcher
    .path("/api/teams/{teamId}/messages")
    .method("get")
    .create();
  const postTeamMessage = fetcher
    .path("/api/teams/{teamId}/messages")
    .method("post")
    .create();
  const cancelSubtask = fetcher
    .path("/api/teams/{teamId}/tasks/{taskId}/cancel")
    .method("post")
    .create();

  const listTasks = fetcher.path("/api/tasks").method("get").create();
  const createTask = fetcher.path("/api/tasks").method("post").create();
  const updateTask = fetcher.path("/api/tasks/{taskId}").method("patch").create();
  const approveTask = fetcher
    .path("/api/tasks/{taskId}/approve")
    .method("post")
    .create();
  const rejectTask = fetcher
    .path("/api/tasks/{taskId}/reject")
    .method("post")
    .create();
  const retryTask = fetcher
    .path("/api/tasks/{taskId}/retry")
    .method("post")
    .create();
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
    getWorkspaceGitStatus: async (
      workspaceId: string
    ): Promise<WorkspaceGitStatusData> =>
      unwrap(
        await requestJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/status`)
      ),
    pullWorkspace: async (
      workspaceId: string
    ): Promise<WorkspaceGitPullData> =>
      unwrap(
        await requestJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/pull`, {
          method: "POST"
        })
      ),
    deleteWorkspace: async (workspaceId: string): Promise<DeleteResult> =>
      unwrap((await deleteWorkspace({ workspaceId })).data),
    listTeams: async (workspaceId?: string): Promise<ListTeamsData> =>
      unwrap((await listTeams(workspaceId ? { workspaceId } : {})).data),
    createTeam: async (body: CreateTeamBody): Promise<AgentTeamData> =>
      unwrap((await createTeam(body)).data),
    getTeam: async (teamId: GetTeamParams["teamId"]): Promise<AgentTeamData> =>
      unwrap((await getTeam({ teamId })).data),
    updateTeam: async (
      teamId: GetTeamParams["teamId"],
      body: UpdateTeamBody
    ): Promise<AgentTeamData> =>
      unwrap((await updateTeam({ teamId, ...body })).data),
    deleteTeam: async (teamId: GetTeamParams["teamId"]): Promise<DeleteResult> =>
      unwrap((await deleteTeam({ teamId })).data),
    listTeamMessages: async (
      teamId: GetTeamParams["teamId"],
      query: ListTeamMessagesQuery = {}
    ): Promise<TeamMessagesData> =>
      unwrap((await listTeamMessages({ teamId, ...query })).data),
    postTeamMessage: async (
      teamId: GetTeamParams["teamId"],
      body: PostTeamMessageBody
    ): Promise<TeamMessageData> =>
      unwrap((await postTeamMessage({ teamId, ...body })).data),
    cancelSubtask: async (
      teamId: GetTeamParams["teamId"],
      taskId: string
    ): Promise<TaskData> =>
      unwrap((await cancelSubtask({ teamId, taskId })).data),
    listTasks: async (workspaceId?: string): Promise<ListTasksData> =>
      unwrap((await listTasks(workspaceId ? { workspaceId } : {})).data),
    createTask: async (body: CreateTaskBody): Promise<TaskData> =>
      unwrap((await createTask(body)).data),
    updateTask: async (
      taskId: string,
      body: UpdateTaskBody
    ): Promise<TaskData> =>
      unwrap((await updateTask({ taskId, ...body })).data),
    approveTask: async (taskId: string): Promise<TaskData> =>
      unwrap((await approveTask({ taskId })).data),
    rejectTask: async (
      taskId: string,
      body: RejectTaskBody = {}
    ): Promise<TaskData> =>
      unwrap((await rejectTask({ taskId, ...body })).data),
    retryTask: async (taskId: string): Promise<TaskData> =>
      unwrap((await retryTask({ taskId })).data),
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
      unwrap((await getRunLog({ runId })).data),
    setTaskDependencies: async (
      taskId: string,
      dependencies: string[]
    ): Promise<{ task: import("@workhorse/contracts").Task }> =>
      unwrap(
        await requestJson(
          `/api/tasks/${encodeURIComponent(taskId)}/dependencies`,
          { method: "PUT", body: JSON.stringify({ dependencies }) }
        )
      ),
    getSchedulerStatus: async (): Promise<{
      running: number;
      queued: number;
      blocked: number;
    }> =>
      unwrap(await requestJson("/api/scheduler/status")),
    listProposals: async (
      teamId: string,
      query: ListProposalsQuery = {}
    ): Promise<{ items: CoordinatorProposal[] }> => {
      const qs = query.parentTaskId
        ? `?parentTaskId=${encodeURIComponent(query.parentTaskId)}`
        : "";
      return unwrap(
        await requestJson(`/api/teams/${encodeURIComponent(teamId)}/proposals${qs}`)
      );
    },
    getProposal: async (
      teamId: string,
      proposalId: string
    ): Promise<{ proposal: CoordinatorProposal }> =>
      unwrap(
        await requestJson(
          `/api/teams/${encodeURIComponent(teamId)}/proposals/${encodeURIComponent(proposalId)}`
        )
      ),
    approveProposal: async (
      teamId: string,
      proposalId: string
    ): Promise<{ proposal: CoordinatorProposal }> =>
      unwrap(
        await requestJson(
          `/api/teams/${encodeURIComponent(teamId)}/proposals/${encodeURIComponent(proposalId)}/approve`,
          { method: "POST" }
        )
      ),
    rejectProposal: async (
      teamId: string,
      proposalId: string
    ): Promise<{ proposal: CoordinatorProposal }> =>
      unwrap(
        await requestJson(
          `/api/teams/${encodeURIComponent(teamId)}/proposals/${encodeURIComponent(proposalId)}/reject`,
          { method: "POST" }
        )
      )
  };
}

export type { paths } from "./generated/openapi";
