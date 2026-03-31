export type TaskColumn =
  | "todo"
  | "running"
  | "review"
  | "done"
  | "archived";

export type RunnerType = "codex" | "shell";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  isGitRepo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShellRunnerConfig {
  type: "shell";
  command: string;
}

export interface CodexRunnerConfig {
  type: "codex";
  prompt: string;
  model?: string;
  approvalMode?: "default" | "auto";
}

export type RunnerConfig = ShellRunnerConfig | CodexRunnerConfig;

export interface Task {
  id: string;
  title: string;
  description: string;
  workspaceId: string;
  column: TaskColumn;
  order: number;
  runnerType: RunnerType;
  runnerConfig: RunnerConfig;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  runnerType: RunnerType;
  command: string;
  pid?: number;
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
  logFile: string;
  metadata?: Record<string, string>;
}

export interface AppState {
  schemaVersion: number;
  workspaces: Workspace[];
  tasks: Task[];
  runs: Run[];
}
