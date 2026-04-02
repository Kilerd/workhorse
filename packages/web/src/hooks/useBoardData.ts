import { useCallback, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";

import type {
  GlobalSettings,
  Run,
  RunLogEntry,
  ServerEvent,
  StartTaskBody,
  Task,
  UpdateSettingsBody,
  UpdateWorkspaceBody,
  Workspace
} from "@workhorse/contracts";

import { api } from "@/lib/api";
import { readStoredValue, writeStoredValue } from "@/lib/persist";
import {
  resolveActiveRunId,
  resolveRunSelectionAfterStart,
  resolveViewedRunId
} from "@/lib/run-selection";
import { applyOptimisticStartTask } from "@/lib/start-task";
import { type DisplayTask, type TaskFormValues } from "@/lib/task-view";

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
  const [liveLogByRunId, setLiveLogByRunId] = useState<Record<string, RunLogEntry[]>>({});
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceSettingsModalOpen, setWorkspaceSettingsModalOpen] = useState(false);
  const [globalSettingsModalOpen, setGlobalSettingsModalOpen] = useState(false);
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
    queryFn: async () => unwrap(await api.health()),
    refetchInterval: 60_000
  });

  const settingsQuery = useQuery({
    queryKey: queryKey("settings"),
    queryFn: async (): Promise<GlobalSettings> => {
      const response = await api.getSettings();
      return unwrap(response).settings;
    }
  });

  const displayedTasks = useMemo<DisplayTask[]>(
    () => tasksQuery.data ?? [],
    [tasksQuery.data]
  );

  const selectedWorkspaceTasks = useMemo(() => {
    if (selectedWorkspaceId === "all") {
      return displayedTasks;
    }
    return displayedTasks.filter((task) => task.workspaceId === selectedWorkspaceId);
  }, [displayedTasks, selectedWorkspaceId]);

  const selectedTask = useMemo(() => {
    return selectedTaskId
      ? displayedTasks.find((task) => task.id === selectedTaskId) ?? null
      : null;
  }, [displayedTasks, selectedTaskId]);

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

  const activeRunId = useMemo(() => {
    const runs = selectedTaskRunsQuery.data ?? [];
    return resolveActiveRunId(runs);
  }, [selectedTaskRunsQuery.data]);

  const viewedRunId = useMemo(() => {
    return resolveViewedRunId({
      runs: selectedTaskRunsQuery.data ?? [],
      selectedRunId,
      lastRunId: selectedTask?.lastRunId
    });
  }, [selectedRunId, selectedTask?.lastRunId, selectedTaskRunsQuery.data]);

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
    mutationFn: async (input: TaskFormValues) => {
      const response = await api.createTask(input);
      return unwrap(response).task;
    },
    onSuccess: async (task) => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      setSelectedTaskId(task.id);
      setTaskModalOpen(false);
    }
  });

  const updateWorkspaceMutation = useMutation({
    mutationFn: async ({
      workspaceId,
      body
    }: {
      workspaceId: string;
      body: UpdateWorkspaceBody;
    }) => {
      const response = await api.updateWorkspace(workspaceId, body);
      return unwrap(response).workspace;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("workspaces") });
    }
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (body: UpdateSettingsBody) => {
      const response = await api.updateSettings(body);
      return unwrap(response).settings;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("settings") });
    }
  });

  const startTaskMutation = useMutation({
    mutationFn: async ({
      taskId,
      body
    }: {
      taskId: string;
      body?: StartTaskBody;
    }) => {
      const response = await api.startTask(taskId, body);
      return unwrap(response);
    },
    onMutate: async ({ taskId, body }) => {
      await queryClient.cancelQueries({ queryKey: queryKey("tasks") });
      const previousTasks = queryClient.getQueryData<Task[]>(queryKey("tasks"));
      if (previousTasks) {
        queryClient.setQueryData<Task[]>(
          queryKey("tasks"),
          applyOptimisticStartTask(previousTasks, taskId, body)
        );
      }
      return { previousTasks };
    },
    onError: async (_error, _variables, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(queryKey("tasks"), context.previousTasks);
      }

      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      await queryClient.invalidateQueries({ queryKey: queryKey("runs") });
    },
    onSuccess: async (result, { taskId }) => {
      if (taskId === selectedTaskId) {
        setSelectedRunId((current) =>
          resolveRunSelectionAfterStart({
            selectedRunId: current,
            previousLastRunId: selectedTask?.lastRunId,
            startedRunId: result.run.id
          })
        );
      }

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

  const sendTaskInputMutation = useMutation({
    mutationFn: async ({
      taskId,
      text
    }: {
      taskId: string;
      text: string;
    }) => {
      const response = await api.sendTaskInput(taskId, { text });
      return unwrap(response);
    },
    onSuccess: async (result, { taskId }) => {
      if (taskId === selectedTaskId) {
        setSelectedRunId(result.run.id);
      }

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

  const planTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.planTask(taskId);
      return unwrap(response).task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    }
  });

  const cleanupTaskWorktreeMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.cleanupTaskWorktree(taskId);
      return unwrap(response).task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    }
  });

  const moveToTodoMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.updateTask(taskId, { column: "todo" });
      return unwrap(response).task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    }
  });

  const markDoneMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.updateTask(taskId, { column: "done" });
      return unwrap(response).task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    }
  });

  const archiveMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.updateTask(taskId, { column: "archived" });
      return unwrap(response).task;
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

  const setWorkspaceSelection = useCallback((workspaceId: string | "all") => {
    setSelectedWorkspaceId(workspaceId);
    writeStoredValue(STORAGE_KEYS.selectedWorkspaceId, workspaceId);
  }, []);

  const setTaskSelection = useCallback((taskId: string | null) => {
    setSelectedTaskId(taskId);
    writeStoredValue(STORAGE_KEYS.selectedTaskId, taskId);
    setSelectedRunId(null);
  }, []);

  const startTask = useCallback(
    (taskId: string, body?: StartTaskBody) =>
      startTaskMutation.mutateAsync({ taskId, body }),
    [startTaskMutation]
  );

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
    queryClient,
    healthQuery,
    workspacesQuery,
    tasksQuery,
    settingsQuery,
    displayedTasks,
    selectedWorkspaceId,
    selectedWorkspaceTasks,
    selectedTask,
    selectedTaskRunsQuery,
    activeRunId,
    viewedRunId,
    selectedRunId,
    liveLogByRunId,
    workspaceModalOpen,
    workspaceSettingsModalOpen,
    globalSettingsModalOpen,
    taskModalOpen,
    setWorkspaceModalOpen,
    setWorkspaceSettingsModalOpen,
    setGlobalSettingsModalOpen,
    setTaskModalOpen,
    setWorkspaceSelection,
    setTaskSelection,
    setSelectedRunId,
    recordLiveOutput,
    clearLiveOutput,
    createWorkspace: createWorkspaceMutation.mutateAsync,
    updateSettings: updateSettingsMutation.mutateAsync,
    updateWorkspace: updateWorkspaceMutation.mutateAsync,
    createTask: createTaskMutation.mutateAsync,
    isCreatingTask: createTaskMutation.isPending,
    startTask,
    stopTask: stopTaskMutation.mutateAsync,
    sendTaskInput: sendTaskInputMutation.mutateAsync,
    updateTask: updateTaskMutation.mutateAsync,
    planTask: planTaskMutation.mutateAsync,
    cleanupTaskWorktree: cleanupTaskWorktreeMutation.mutateAsync,
    moveToTodo: moveToTodoMutation.mutateAsync,
    markDone: markDoneMutation.mutateAsync,
    archiveTask: archiveMutation.mutateAsync,
    deleteWorkspace: deleteWorkspaceMutation.mutateAsync,
    deleteTask: deleteTaskMutation.mutateAsync,
    isBusy:
      createWorkspaceMutation.isPending ||
      updateSettingsMutation.isPending ||
      updateWorkspaceMutation.isPending ||
      createTaskMutation.isPending ||
      startTaskMutation.isPending ||
      stopTaskMutation.isPending ||
      sendTaskInputMutation.isPending ||
      updateTaskMutation.isPending ||
      planTaskMutation.isPending ||
      cleanupTaskWorktreeMutation.isPending ||
      moveToTodoMutation.isPending ||
      markDoneMutation.isPending ||
      archiveMutation.isPending ||
      deleteWorkspaceMutation.isPending ||
      deleteTaskMutation.isPending
  };
}
