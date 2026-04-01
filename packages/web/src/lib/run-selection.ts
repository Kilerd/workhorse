import type { Run } from "@workhorse/contracts";

interface ResolveViewedRunIdOptions {
  runs: Run[];
  selectedRunId: string | null;
  lastRunId?: string;
}

interface ResolveRunSelectionAfterStartOptions {
  selectedRunId: string | null;
  previousLastRunId?: string;
  startedRunId: string;
}

export function resolveActiveRunId(runs: Run[]): string | null {
  return runs.find((run) => run.status === "running")?.id ?? null;
}

export function resolveViewedRunId({
  runs,
  selectedRunId,
  lastRunId
}: ResolveViewedRunIdOptions): string | null {
  if (selectedRunId && runs.some((run) => run.id === selectedRunId)) {
    return selectedRunId;
  }

  return resolveActiveRunId(runs) ?? runs[0]?.id ?? lastRunId ?? null;
}

export function resolveRunSelectionAfterStart({
  selectedRunId,
  previousLastRunId,
  startedRunId
}: ResolveRunSelectionAfterStartOptions): string {
  return selectedRunId ?? previousLastRunId ?? startedRunId;
}
