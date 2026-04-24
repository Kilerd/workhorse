import type {
  AccountAgent,
  Message,
  Plan,
  Run,
  RunLogEntry,
  Task,
  Thread,
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

// === Agent-driven board (Spec 02) ===

export interface ThreadMessageEvent {
  type: "thread.message";
  threadId: string;
  message: Message;
}

export interface ThreadUpdatedEvent {
  type: "thread.updated";
  action: "created" | "updated" | "archived";
  threadId: string;
  thread?: Thread;
}

export interface PlanCreatedEvent {
  type: "plan.created";
  planId: string;
  plan: Plan;
}

export interface PlanUpdatedEvent {
  type: "plan.updated";
  planId: string;
  plan: Plan;
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
  | AgentUpdatedEvent
  | WorkspaceAgentUpdatedEvent
  | ThreadMessageEvent
  | ThreadUpdatedEvent
  | PlanCreatedEvent
  | PlanUpdatedEvent;
