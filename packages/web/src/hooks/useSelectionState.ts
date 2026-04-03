import { useCallback, useState } from "react";
import { readStoredValue, writeStoredValue } from "@/lib/persist";

const STORAGE_KEYS = {
  selectedWorkspaceId: "workhorse.selectedWorkspaceId",
  selectedTaskId: "workhorse.selectedTaskId"
} as const;

export function useSelectionState() {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | "all">(
    () => readStoredValue<string | "all">(STORAGE_KEYS.selectedWorkspaceId, "all")
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() =>
    readStoredValue<string | null>(STORAGE_KEYS.selectedTaskId, null)
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const setWorkspaceSelection = useCallback((workspaceId: string | "all") => {
    setSelectedWorkspaceId(workspaceId);
    writeStoredValue(STORAGE_KEYS.selectedWorkspaceId, workspaceId);
  }, []);

  const setTaskSelection = useCallback((taskId: string | null) => {
    setSelectedTaskId(taskId);
    writeStoredValue(STORAGE_KEYS.selectedTaskId, taskId);
    setSelectedRunId(null);
  }, []);

  return {
    selectedWorkspaceId,
    selectedTaskId,
    selectedRunId,
    setSelectedRunId,
    setWorkspaceSelection,
    setTaskSelection
  };
}
