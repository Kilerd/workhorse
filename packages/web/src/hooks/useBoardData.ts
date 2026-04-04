import { useCallback, useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";

import type {
  GlobalSettings,
  Run,
  StartTaskBody,
  Task,
  TaskColumn,
  UpdateSettingsBody,
  UpdateWorkspaceBody,
  Workspace
} from "@workhorse/contracts";

import { api } from "@/lib/api";
import {
  resolveActiveRunId,
  resolveRunSelectionAfterStart,
  resolveViewedRunId
} from "@/lib/run-selection";
import { applyOptimisticStartTask } from "@/lib/start-task";
import { type DisplayTask, type TaskFormValues } from "@/lib/task-view";

import { useLiveLog } from "./useLiveLog";
import { useModalState } from "./useModalState";
import { useSelectionState } from "./useSelectionState";

function queryKey(name: string, extra?: string) {
  return extra ? [name, extra] : [name];
}

export function useBoardData() {
  const queryClient = useQueryClient();
  const modals = useModalState();
  const liveLog = useLiveLog();
  const selection = useSelectionState();

  const workspacesQuery = useQuery({
    queryKey: queryKey("workspaces"),
    queryFn: async (): Promise<Workspace[]> => {
      const response = await api.listWorkspaces();
      return response.items;
    }
  });

  const tasksQuery = useQuery({
    queryKey: queryKey("tasks"),
    queryFn: async (): Promise<Task[]> => {
      const response = await api.listTasks();
      return response.items;
    }
  });

  const healthQuery = useQuery({
    queryKey: queryKey("health"),
    queryFn: async () => api.health(),
    refetchInterval: 60_000
  });

  const settingsQuery = useQuery({
    queryKey: queryKey("settings"),
    queryFn: async (): Promise<GlobalSettings> => {
      const response = await api.getSettings();
      return response.settings;
    }
  });

  const displayedTasks = useMemo<DisplayTask[]>(
    () => tasksQuery.data ?? [],
    [tasksQuery.data]
  );

  const selectedWorkspaceTasks = useMemo(() => {
    if (selection.selectedWorkspaceId === "all") {
      return displayedTasks;
    }
    return displayedTasks.filter((task) => task.workspaceId === selection.selectedWorkspaceId);
  }, [displayedTasks, selection.selectedWorkspaceId]);

  const selectedTask = useMemo(() => {
    return selection.selectedTaskId
      ? displayedTasks.find((task) => task.id === selection.selectedTaskId) ?? null
      : null;
  }, [displayedTasks, selection.selectedTaskId]);

  const selectedTaskRunsQuery = useQuery({
    queryKey: queryKey("runs", selectedTask?.id ?? ""),
    queryFn: async (): Promise<Run[]> => {
      if (!selectedTask?.id) {
        return [];
      }
      const response = await api.listRuns(selectedTask.id);
      return response.items;
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
      selectedRunId: selection.selectedRunId,
      lastRunId: selectedTask?.lastRunId
    });
  }, [selection.selectedRunId, selectedTask?.lastRunId, selectedTaskRunsQuery.data]);

  const createWorkspaceMutation = useMutation({
    mutationFn: async (input: { name: string; rootPath: string }) => {
      const response = await api.createWorkspace(input);
      return response.workspace;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("workspaces") });
    }
  });

  const createTaskMutation = useMutation({
    mutationFn: async (input: TaskFormValues) => {
      const response = await api.createTask(input);
      return response.task;
    },
    onSuccess: async (task) => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      selection.setTaskSelection(task.id);
      modals.setTaskModalOpen(false);
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
      return response.workspace;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("workspaces") });
    }
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (body: UpdateSettingsBody) => {
      const response = await api.updateSettings(body);
      return response.settings;
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
      return response;
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
      if (taskId === selection.selectedTaskId) {
        selection.setSelectedRunId((current: string | null) =>
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
      return response;
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
      return response;
    },
    onSuccess: async (result, { taskId }) => {
      if (taskId === selection.selectedTaskId) {
        selection.setSelectedRunId(result.run.id);
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
      return response.task;
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
      return response;
    },
    onSuccess: async (result, taskId) => {
      if (taskId === selection.selectedTaskId) {
        selection.setSelectedRunId(result.run.id);
      }

      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      await queryClient.invalidateQueries({ queryKey: queryKey("runs") });
    }
  });

  const sendPlanFeedbackMutation = useMutation({
    mutationFn: async ({
      taskId,
      text
    }: {
      taskId: string;
      text: string;
    }) => {
      const response = await api.sendPlanFeedback(taskId, { text });
      return response;
    },
    onSuccess: async (result, { taskId }) => {
      if (taskId === selection.selectedTaskId) {
        selection.setSelectedRunId(result.run.id);
      }

      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      await queryClient.invalidateQueries({ queryKey: queryKey("runs") });
    }
  });

  const requestTaskReviewMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.requestTaskReview(taskId);
      return response;
    },
    onSuccess: async (result, taskId) => {
      if (taskId === selection.selectedTaskId) {
        selection.setSelectedRunId(result.run.id);
      }

      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      await queryClient.invalidateQueries({ queryKey: queryKey("runs") });
    }
  });

  const cleanupTaskWorktreeMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.cleanupTaskWorktree(taskId);
      return response.task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    }
  });

  const changeColumnMutation = useMutation({
    mutationFn: async ({ taskId, column }: { taskId: string; column: TaskColumn }) => {
      const response = await api.updateTask(taskId, { column });
      return response.task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    }
  });

  const deleteWorkspaceMutation = useMutation({
    mutationFn: async (workspaceId: string) => {
      const response = await api.deleteWorkspace(workspaceId);
      return response;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("workspaces") });
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      selection.setWorkspaceSelection("all");
    }
  });

  const deleteTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.deleteTask(taskId);
      return response;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      selection.setTaskSelection(null);
    }
  });

  const startTask = useCallback(
    (taskId: string, body?: StartTaskBody) =>
      startTaskMutation.mutateAsync({ taskId, body }),
    [startTaskMutation]
  );

  return {
    queryClient,
    healthQuery,
    workspacesQuery,
    tasksQuery,
    settingsQuery,
    displayedTasks,
    selectedWorkspaceId: selection.selectedWorkspaceId,
    selectedWorkspaceTasks,
    selectedTask,
    selectedTaskRunsQuery,
    activeRunId,
    viewedRunId,
    selectedRunId: selection.selectedRunId,
    liveLogByRunId: liveLog.liveLogByRunId,
    workspaceModalOpen: modals.workspaceModalOpen,
    workspaceSettingsModalOpen: modals.workspaceSettingsModalOpen,
    globalSettingsModalOpen: modals.globalSettingsModalOpen,
    taskModalOpen: modals.taskModalOpen,
    setWorkspaceModalOpen: modals.setWorkspaceModalOpen,
    setWorkspaceSettingsModalOpen: modals.setWorkspaceSettingsModalOpen,
    setGlobalSettingsModalOpen: modals.setGlobalSettingsModalOpen,
    setTaskModalOpen: modals.setTaskModalOpen,
    setWorkspaceSelection: selection.setWorkspaceSelection,
    setTaskSelection: selection.setTaskSelection,
    setSelectedRunId: selection.setSelectedRunId,
    recordLiveOutput: liveLog.recordLiveOutput,
    clearLiveOutput: liveLog.clearLiveOutput,
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
    sendPlanFeedback: sendPlanFeedbackMutation.mutateAsync,
    requestTaskReview: requestTaskReviewMutation.mutateAsync,
    cleanupTaskWorktree: cleanupTaskWorktreeMutation.mutateAsync,
    moveToTodo: (taskId: string) => changeColumnMutation.mutateAsync({ taskId, column: "todo" }),
    markDone: (taskId: string) => changeColumnMutation.mutateAsync({ taskId, column: "done" }),
    archiveTask: (taskId: string) => changeColumnMutation.mutateAsync({ taskId, column: "archived" }),
    deleteWorkspace: deleteWorkspaceMutation.mutateAsync,
    deleteTask: deleteTaskMutation.mutateAsync,
    isBusy: [
      createWorkspaceMutation,
      updateSettingsMutation,
      updateWorkspaceMutation,
      createTaskMutation,
      startTaskMutation,
      stopTaskMutation,
      sendTaskInputMutation,
      updateTaskMutation,
      planTaskMutation,
      sendPlanFeedbackMutation,
      requestTaskReviewMutation,
      cleanupTaskWorktreeMutation,
      changeColumnMutation,
      deleteWorkspaceMutation,
      deleteTaskMutation
    ].some((m) => m.isPending)
  };
}
