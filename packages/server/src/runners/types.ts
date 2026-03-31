import type { Run, RunStatus, Task, Workspace } from "@workhorse/contracts";

export interface RunnerStartContext {
  run: Run;
  task: Task;
  workspace: Workspace;
}

export interface RunnerLifecycleHooks {
  onOutput(chunk: string, stream: "stdout" | "stderr" | "system"): Promise<void>;
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
}

export interface RunnerAdapter {
  readonly type: "codex" | "shell";
  start(
    context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl>;
}
