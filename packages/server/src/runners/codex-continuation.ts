import type { Run, Task } from "@workhorse/contracts";

export function cloneRun(run: Run): Run {
  return {
    ...run,
    metadata: run.metadata ? { ...run.metadata } : undefined
  };
}

export function resolveContinuationCandidateRunId(
  task: Task,
  runnerType: Run["runnerType"]
): string | undefined {
  if (runnerType === "codex") {
    return task.continuationRunId ?? task.lastRunId;
  }

  return task.lastRunId;
}

export function canContinueCodexRun(
  runnerType: Run["runnerType"],
  previousRun?: Run
): previousRun is Run {
  if (runnerType !== "codex" || previousRun?.runnerType !== "codex") {
    return false;
  }

  return Boolean(previousRun.metadata?.threadId?.trim());
}

export function buildContinuationRunMetadata(
  previousMetadata?: Record<string, string>,
  nextMetadata?: Record<string, string>
): Record<string, string> | undefined {
  const metadata = {
    ...(previousMetadata?.threadId ? { threadId: previousMetadata.threadId } : {}),
    ...(previousMetadata?.turnId ? { turnId: previousMetadata.turnId } : {}),
    ...(previousMetadata?.prUrl ? { prUrl: previousMetadata.prUrl } : {}),
    ...(nextMetadata ?? {})
  };

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function buildContinuationRun(
  previousRun: Run,
  createLogPath: (runId: string) => string,
  runMetadata?: Record<string, string>
): Run {
  return {
    id: previousRun.id,
    taskId: previousRun.taskId,
    status: "queued",
    runnerType: previousRun.runnerType,
    command: "",
    startedAt: new Date().toISOString(),
    logFile: createLogPath(previousRun.id),
    metadata: buildContinuationRunMetadata(previousRun.metadata, runMetadata)
  };
}
