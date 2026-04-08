import { useCallback, useState } from "react";
import type { RunLogEntry, ServerEvent } from "@workhorse/contracts";

export type LiveLogByRunId = Record<string, RunLogEntry[]>;

export function appendLiveLogEntry(
  current: LiveLogByRunId,
  event: ServerEvent
): LiveLogByRunId {
  if (event.type !== "run.output") {
    return current;
  }

  return {
    ...current,
    [event.runId]: [...(current[event.runId] ?? []), event.entry]
  };
}

export function clearLiveLogRun(
  current: LiveLogByRunId,
  runId: string
): LiveLogByRunId {
  if (!(runId in current)) {
    return current;
  }

  const next = { ...current };
  delete next[runId];
  return next;
}

export function useLiveLog() {
  const [liveLogByRunId, setLiveLogByRunId] = useState<LiveLogByRunId>({});

  const recordLiveOutput = useCallback((event: ServerEvent) => {
    if (event.type !== "run.output") {
      return;
    }

    setLiveLogByRunId((current) => appendLiveLogEntry(current, event));
  }, []);

  const clearLiveOutput = useCallback((runId: string) => {
    setLiveLogByRunId((current) => clearLiveLogRun(current, runId));
  }, []);

  return {
    liveLogByRunId,
    recordLiveOutput,
    clearLiveOutput
  };
}
