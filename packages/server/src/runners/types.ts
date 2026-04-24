import type {
  Run,
  RunLogKind,
  RunLogStream,
  RunStatus,
  RunnerConfig,
  RunnerType,
  Task,
  Workspace
} from "@workhorse/contracts";

export interface RunnerStartContext {
  run: Run;
  previousRun?: Run;
  task: Task;
  runnerConfig: RunnerConfig;
  workspace: Workspace;
  inputText?: string;
  resumeSessionId?: string;
}

export interface RunnerLifecycleHooks {
  onOutput(entry: {
    kind: RunLogKind;
    text: string;
    stream: RunLogStream;
    title?: string;
    source?: string;
    metadata?: Record<string, string>;
  }): Promise<void>;
  onExit(result: {
    status: RunStatus;
    exitCode?: number;
    metadata?: Record<string, string>;
  }): Promise<void>;
}

export interface RunnerControl {
  pid?: number;
  command: string;
  metadata?: Record<string, string>;
  stop(): Promise<void>;
  sendInput?(input: string): Promise<{ metadata?: Record<string, string> } | void>;
}

export interface RunnerAdapter {
  readonly type: RunnerType;
  start(
    context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl>;
}
