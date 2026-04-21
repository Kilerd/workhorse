import { useCallback, useState } from "react";
import { readStoredValue, writeStoredValue } from "@/lib/persist";

const STORAGE_KEYS = {
  selectedWorkspaceId: "workhorse.selectedWorkspaceId",
  selectedTaskId: "workhorse.selectedTaskId",
  selectedChannelId: "workhorse.selectedChannelId",
  sidebarCollapsed: "workhorse.sidebarCollapsed"
} as const;

export function useSelectionState() {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | "all">(
    () => readStoredValue<string | "all">(STORAGE_KEYS.selectedWorkspaceId, "all")
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() =>
    readStoredValue<string | null>(STORAGE_KEYS.selectedTaskId, null)
  );
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(() =>
    readStoredValue<string | null>(STORAGE_KEYS.selectedChannelId, null)
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsedRaw] = useState<boolean>(
    () => readStoredValue<boolean>(STORAGE_KEYS.sidebarCollapsed, false)
  );

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsedRaw((current) => {
      const next = !current;
      writeStoredValue(STORAGE_KEYS.sidebarCollapsed, next);
      return next;
    });
  }, []);

  const setSidebarCollapsed = useCallback((value: boolean) => {
    setSidebarCollapsedRaw(value);
    writeStoredValue(STORAGE_KEYS.sidebarCollapsed, value);
  }, []);

  const setWorkspaceSelection = useCallback((workspaceId: string | "all") => {
    setSelectedWorkspaceId(workspaceId);
    writeStoredValue(STORAGE_KEYS.selectedWorkspaceId, workspaceId);
  }, []);

  const setTaskSelection = useCallback((taskId: string | null) => {
    setSelectedTaskId(taskId);
    writeStoredValue(STORAGE_KEYS.selectedTaskId, taskId);
    setSelectedRunId(null);
  }, []);

  const setChannelSelection = useCallback((channelId: string | null) => {
    setSelectedChannelId(channelId);
    writeStoredValue(STORAGE_KEYS.selectedChannelId, channelId);
  }, []);

  return {
    selectedWorkspaceId,
    selectedTaskId,
    selectedChannelId,
    selectedRunId,
    sidebarCollapsed,
    setSelectedRunId,
    setWorkspaceSelection,
    setTaskSelection,
    setChannelSelection,
    toggleSidebarCollapsed,
    setSidebarCollapsed
  };
}
