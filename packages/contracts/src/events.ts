import type { Run, Task, Workspace } from "./domain.js";

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
  chunk: string;
  stream: "stdout" | "stderr" | "system";
  timestamp: string;
}

export interface RunFinishedEvent {
  type: "run.finished";
  taskId: string;
  run: Run;
  task: Task;
}

export type ServerEvent =
  | WorkspaceUpdatedEvent
  | TaskUpdatedEvent
  | RunStartedEvent
  | RunOutputEvent
  | RunFinishedEvent;
