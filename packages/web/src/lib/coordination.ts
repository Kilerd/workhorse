import type { Workspace, WorkspaceAgent } from "@workhorse/contracts";

import type { DisplayTask } from "./task-view";

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

export function resolveWorkspaceAgentName(
  task: DisplayTask,
  workspaceAgents: WorkspaceAgent[]
): string | null {
  if (!task.assigneeAgentId) {
    return null;
  }
  return (
    workspaceAgents.find((agent) => agent.id === task.assigneeAgentId)?.name ?? null
  );
}

export function getCoordinationBadgeLabel(input: {
  task: DisplayTask;
  workspace: Workspace | null;
  workspaceAgents?: WorkspaceAgent[];
}): string | null {
  const { task, workspace, workspaceAgents = [] } = input;

  if (task.parentTaskId) {
    return null;
  }

  return hasWorkspaceCoordinator(workspaceAgents)
    ? `Agents${workspace ? ` · ${workspace.name}` : ""}`
    : null;
}
