import { useCallback, useState } from "react";
import type { RunLogEntry, ServerEvent } from "@workhorse/contracts";

export function useLiveLog() {
  const [liveLogByRunId, setLiveLogByRunId] = useState<Record<string, RunLogEntry[]>>({});

  const recordLiveOutput = useCallback((event: ServerEvent) => {
    if (event.type !== "run.output") {
      return;
    }

    setLiveLogByRunId((current) => ({
      ...current,
      [event.runId]: [...(current[event.runId] ?? []), event.entry]
    }));
  }, []);

  const clearLiveOutput = useCallback((runId: string) => {
    setLiveLogByRunId((current) => {
      if (!(runId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[runId];
      return next;
    });
  }, []);

  return {
    liveLogByRunId,
    recordLiveOutput,
    clearLiveOutput
  };
}
