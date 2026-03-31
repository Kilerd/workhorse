import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";

import type {
  CreateTaskBody,
  Run,
  ServerEvent,
  Task,
  TaskColumn,
  Workspace
} from "@workhorse/contracts";

import { api } from "@/lib/api";
import { readStoredValue, writeStoredValue } from "@/lib/persist";

const STORAGE_KEYS = {
  selectedWorkspaceId: "workhorse.selectedWorkspaceId",
  selectedTaskId: "workhorse.selectedTaskId"
} as const;

function unwrap<T>(payload: { ok: true; data: T }): T {
  return payload.data;
}

function queryKey(name: string, extra?: string) {
  return extra ? [name, extra] : [name];
}

export function useBoardData() {
  const queryClient = useQueryClient();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | "all">(
    () => readStoredValue<string | "all">(STORAGE_KEYS.selectedWorkspaceId, "all")
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() =>
    readStoredValue<string | null>(STORAGE_KEYS.selectedTaskId, null)
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [liveLogByRunId, setLiveLogByRunId] = useState<Record<string, string>>({});
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);

  const workspacesQuery = useQuery({
    queryKey: queryKey("workspaces"),
    queryFn: async (): Promise<Workspace[]> => {
      const response = await api.listWorkspaces();
      return unwrap(response).items;
    }
  });

  const tasksQuery = useQuery({
    queryKey: queryKey("tasks"),
    queryFn: async (): Promise<Task[]> => {
      const response = await api.listTasks();
      return unwrap(response).items;
    }
  });

  const healthQuery = useQuery({
    queryKey: queryKey("health"),
    queryFn: async () => unwrap(await api.health())
  });

  const selectedWorkspaceTasks = useMemo(() => {
    const tasks = tasksQuery.data ?? [];
    if (selectedWorkspaceId === "all") {
      return tasks;
    }
    return tasks.filter((task) => task.workspaceId === selectedWorkspaceId);
  }, [selectedWorkspaceId, tasksQuery.data]);

  const selectedTask = useMemo(() => {
    return selectedTaskId
      ? (tasksQuery.data ?? []).find((task) => task.id === selectedTaskId) ?? null
      : null;
  }, [selectedTaskId, tasksQuery.data]);

  const selectedTaskRunsQuery = useQuery({
    queryKey: queryKey("runs", selectedTask?.id ?? ""),
    queryFn: async (): Promise<Run[]> => {
      if (!selectedTask?.id) {
        return [];
      }
      const response = await api.listRuns(selectedTask.id);
      return unwrap(response).items;
    },
    enabled: Boolean(selectedTask?.id)
  });

  const selectedRun = useMemo(() => {
    const runs = selectedTaskRunsQuery.data ?? [];
    return (
      runs.find((run) => run.id === selectedRunId) ??
      runs.find((run) => run.status === "running") ??
      runs[0] ??
      null
    );
  }, [selectedRunId, selectedTaskRunsQuery.data]);

  const selectedRunLogQuery = useQuery({
    queryKey: queryKey("run-log", selectedRun?.id ?? ""),
    queryFn: async () => {
      if (!selectedRun?.id) {
        return "";
      }
      const response = await api.getRunLog(selectedRun.id);
      return unwrap(response).content;
    },
    enabled: Boolean(selectedRun?.id)
  });

  const createWorkspaceMutation = useMutation({
    mutationFn: async (input: { name: string; rootPath: string }) => {
      const response = await api.createWorkspace(input);
      return unwrap(response).workspace;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("workspaces") });
    }
  });

  const createTaskMutation = useMutation({
    mutationFn: async (input: CreateTaskBody) => {
      const response = await api.createTask(input);
      return unwrap(response).task;
    },
    onSuccess: async (task) => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      setSelectedTaskId(task.id);
      setTaskModalOpen(false);
    }
  });

  const startTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.startTask(taskId);
      return unwrap(response);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      await queryClient.invalidateQueries({ queryKey: queryKey("runs") });
    }
  });

  const stopTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.stopTask(taskId);
      return unwrap(response);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      await queryClient.invalidateQueries({ queryKey: queryKey("runs") });
    }
  });

  const updateTaskMutation = useMutation({
    mutationFn: async ({
      taskId,
      body
    }: {
      taskId: string;
      body: Record<string, unknown>;
    }) => {
      const response = await api.updateTask(taskId, body);
      return unwrap(response).task;
    },
    onMutate: async ({ taskId, body }) => {
      await queryClient.cancelQueries({ queryKey: queryKey("tasks") });
      const previous = queryClient.getQueryData<Task[]>(queryKey("tasks"));
      if (previous) {
        queryClient.setQueryData<Task[]>(
          queryKey("tasks"),
          previous.map((task) => (task.id === taskId ? { ...task, ...body } : task))
        );
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey("tasks"), context.previous);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    }
  });

  const deleteWorkspaceMutation = useMutation({
    mutationFn: async (workspaceId: string) => {
      const response = await api.deleteWorkspace(workspaceId);
      return unwrap(response);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("workspaces") });
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      setSelectedWorkspaceId("all");
    }
  });

  const deleteTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.deleteTask(taskId);
      return unwrap(response);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      setSelectedTaskId(null);
      setSelectedRunId(null);
    }
  });

  function setWorkspaceSelection(workspaceId: string | "all") {
    setSelectedWorkspaceId(workspaceId);
    writeStoredValue(STORAGE_KEYS.selectedWorkspaceId, workspaceId);
  }

  function setTaskSelection(taskId: string | null) {
    setSelectedTaskId(taskId);
    writeStoredValue(STORAGE_KEYS.selectedTaskId, taskId);
    setSelectedRunId(null);
  }

  function recordLiveOutput(event: ServerEvent) {
    if (event.type !== "run.output") {
      return;
    }
    setLiveLogByRunId((current) => ({
      ...current,
      [event.runId]: `${current[event.runId] ?? ""}${event.chunk}`
    }));
  }

  function clearLiveOutput(runId: string) {
    setLiveLogByRunId((current) => {
      if (!(runId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[runId];
      return next;
    });
  }

  return {
    queryClient,
    healthQuery,
    workspacesQuery,
    tasksQuery,
    selectedWorkspaceId,
    selectedWorkspaceTasks,
    selectedTask,
    selectedTaskRunsQuery,
    selectedRun,
    selectedRunLogQuery,
    selectedRunId,
    liveLogByRunId,
    workspaceModalOpen,
    taskModalOpen,
    setWorkspaceModalOpen,
    setTaskModalOpen,
    setWorkspaceSelection,
    setTaskSelection,
    setSelectedRunId,
    recordLiveOutput,
    clearLiveOutput,
    createWorkspace: createWorkspaceMutation.mutateAsync,
    createTask: createTaskMutation.mutateAsync,
    startTask: startTaskMutation.mutateAsync,
    stopTask: stopTaskMutation.mutateAsync,
    updateTask: updateTaskMutation.mutateAsync,
    deleteWorkspace: deleteWorkspaceMutation.mutateAsync,
    deleteTask: deleteTaskMutation.mutateAsync,
    isBusy:
      createWorkspaceMutation.isPending ||
      createTaskMutation.isPending ||
      startTaskMutation.isPending ||
      stopTaskMutation.isPending ||
      updateTaskMutation.isPending ||
      deleteWorkspaceMutation.isPending ||
      deleteTaskMutation.isPending
  };
}
