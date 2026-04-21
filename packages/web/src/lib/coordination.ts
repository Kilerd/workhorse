import type {
  AccountAgent,
  AgentTeam,
  TaskMessage,
  TeamMessage,
  Workspace,
  WorkspaceAgent
} from "@workhorse/contracts";

import type { DisplayTask } from "./task-view";

export type CoordinationMessage = Pick<
  TaskMessage,
  "id" | "parentTaskId" | "taskId" | "agentName" | "senderType" | "messageType" | "content" | "createdAt"
>;

export type CoordinationScope =
  | { kind: "none" }
  | { kind: "legacy_team"; teamId: string; parentTaskId: string }
  | { kind: "workspace"; workspaceId: string; parentTaskId: string };

export function getCoordinatorWorkspaceAgent(
  agents: WorkspaceAgent[]
): WorkspaceAgent | null {
  return agents.find((agent) => agent.role === "coordinator") ?? null;
}

export function countWorkspaceWorkers(agents: WorkspaceAgent[]): number {
  return agents.filter((agent) => agent.role === "worker").length;
}

export function hasWorkspaceCoordinator(agents: WorkspaceAgent[]): boolean {
  return getCoordinatorWorkspaceAgent(agents) !== null;
}

export function getTaskCoordinationScope(
  task: DisplayTask | null,
  workspaceAgents: WorkspaceAgent[] = []
): CoordinationScope {
  if (!task) {
    return { kind: "none" };
  }

  if (task.teamId) {
    return {
      kind: "legacy_team",
      teamId: task.teamId,
      parentTaskId: task.parentTaskId ?? task.id
    };
  }

  if (task.parentTaskId) {
    return {
      kind: "workspace",
      workspaceId: task.workspaceId,
      parentTaskId: task.parentTaskId
    };
  }

  if (hasWorkspaceCoordinator(workspaceAgents)) {
    return {
      kind: "workspace",
      workspaceId: task.workspaceId,
      parentTaskId: task.id
    };
  }

  return { kind: "none" };
}

export function isCoordinationSubtask(task: DisplayTask, scope: CoordinationScope): boolean {
  return scope.kind !== "none" && Boolean(task.parentTaskId);
}

export function normalizeCoordinationMessages(
  messages: Array<TaskMessage | TeamMessage>
): CoordinationMessage[] {
  return messages.map((message) => ({
    id: message.id,
    parentTaskId: message.parentTaskId,
    taskId: message.taskId,
    agentName: message.agentName,
    senderType: message.senderType,
    messageType: message.messageType,
    content: message.content,
    createdAt: message.createdAt
  }));
}

export function resolveCoordinationAgentName(input: {
  task: DisplayTask;
  legacyTeam?: AgentTeam | null;
  accountAgents?: AccountAgent[];
  workspaceAgents?: WorkspaceAgent[];
}): string | null {
  const { task, legacyTeam, accountAgents = [], workspaceAgents = [] } = input;
  if (!task.teamAgentId) {
    return null;
  }

  if (legacyTeam) {
    return legacyTeam.agents.find((agent) => agent.id === task.teamAgentId)?.agentName ?? null;
  }

  const workspaceAgent =
    workspaceAgents.find((agent) => agent.id === task.teamAgentId) ??
    accountAgents.find((agent) => agent.id === task.teamAgentId);
  return workspaceAgent?.name ?? null;
}

export function getCoordinationBadgeLabel(input: {
  task: DisplayTask;
  workspace: Workspace | null;
  workspaceAgents?: WorkspaceAgent[];
}): string | null {
  const { task, workspace, workspaceAgents = [] } = input;
  if (task.teamId) {
    return "Legacy team";
  }

  if (task.parentTaskId) {
    return null;
  }

  return hasWorkspaceCoordinator(workspaceAgents)
    ? `Agents${workspace ? ` · ${workspace.name}` : ""}`
    : null;
}
