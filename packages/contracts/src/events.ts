import type {
  AccountAgent,
  AgentTeam,
  CoordinatorProposal,
  Run,
  RunLogEntry,
  Task,
  TaskMessage,
  Workspace,
  WorkspaceAgent
} from "./domain.js";

export interface WorkspaceUpdatedEvent {
  type: "workspace.updated";
  action: "created" | "updated" | "deleted";
  workspaceId: string;
  workspace?: Workspace;
}

export interface TaskUpdatedEvent {
  type: "task.updated";
  action: "created" | "updated" | "deleted";
  taskId: string;
  task?: Task;
}

export interface RunStartedEvent {
  type: "run.started";
  taskId: string;
  run: Run;
}

export interface RunOutputEvent {
  type: "run.output";
  taskId: string;
  runId: string;
  entry: RunLogEntry;
}

export interface RunFinishedEvent {
  type: "run.finished";
  taskId: string;
  run: Run;
  task: Task;
}

export interface RuntimeReviewMonitorPolledEvent {
  type: "runtime.review-monitor.polled";
  polledAt: string;
}

export interface TaskBlockedEvent {
  type: "task.blocked";
  taskId: string;
  blockedBy: string[];
}

export interface TaskUnblockedEvent {
  type: "task.unblocked";
  taskId: string;
}

export interface SchedulerEvaluatedEvent {
  type: "scheduler.evaluated";
  started: string[];
  blocked: string[];
}

export interface TeamUpdatedEvent {
  type: "team.updated";
  action: "created" | "updated" | "deleted";
  teamId: string;
  team?: AgentTeam;
}

export interface TeamAgentMessageEvent {
  type: "team.agent.message";
  teamId: string;
  parentTaskId: string;
  fromAgentId: string;
  toAgentId?: string;
  messageType: "status" | "artifact" | "context" | "feedback";
  payload: string;
}

export interface TeamTaskCreatedEvent {
  type: "team.task.created";
  teamId: string;
  parentTaskId: string;
  subtasks: Array<{
    taskId: string;
    title: string;
    agentName: string;
  }>;
}

export interface TeamProposalCreatedEvent {
  type: "team.proposal.created";
  teamId: string;
  parentTaskId: string;
  proposal: CoordinatorProposal;
}

export interface TeamProposalUpdatedEvent {
  type: "team.proposal.updated";
  teamId: string;
  parentTaskId: string;
  proposal: CoordinatorProposal;
}

export interface AgentUpdatedEvent {
  type: "agent.updated";
  action: "created" | "updated" | "deleted";
  agentId: string;
  agent?: AccountAgent;
}

export interface WorkspaceAgentUpdatedEvent {
  type: "workspace.agent.updated";
  action: "mounted" | "updated" | "unmounted";
  workspaceId: string;
  agentId: string;
  agent?: WorkspaceAgent;
}

export interface TaskMessageCreatedEvent {
  type: "task.message.created";
  workspaceId: string;
  parentTaskId: string;
  message: TaskMessage;
}

export interface WorkspaceProposalCreatedEvent {
  type: "workspace.proposal.created";
  workspaceId: string;
  parentTaskId: string;
  proposal: CoordinatorProposal;
}

export interface WorkspaceProposalUpdatedEvent {
  type: "workspace.proposal.updated";
  workspaceId: string;
  parentTaskId: string;
  proposal: CoordinatorProposal;
}

export type ServerEvent =
  | WorkspaceUpdatedEvent
  | TaskUpdatedEvent
  | RunStartedEvent
  | RunOutputEvent
  | RunFinishedEvent
  | RuntimeReviewMonitorPolledEvent
  | TaskBlockedEvent
  | TaskUnblockedEvent
  | SchedulerEvaluatedEvent
  | TeamUpdatedEvent
  | TeamAgentMessageEvent
  | TeamTaskCreatedEvent
  | TeamProposalCreatedEvent
  | TeamProposalUpdatedEvent
  | AgentUpdatedEvent
  | WorkspaceAgentUpdatedEvent
  | TaskMessageCreatedEvent
  | WorkspaceProposalCreatedEvent
  | WorkspaceProposalUpdatedEvent;
