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
  Workspace,
  WorkspaceGitStatusData
} from "@workhorse/contracts";

import { api } from "@/lib/api";
import { readErrorMessage } from "@/lib/error-message";
import {
  resolveActiveRunId,
  resolveRunSelectionAfterStart,
  resolveViewedRunId
} from "@/lib/run-selection";
import { applyOptimisticStartTask } from "@/lib/start-task";
import { type DisplayTask, type TaskFormValues } from "@/lib/task-view";
import { toast } from "@/hooks/use-toast";

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
  const notifyMutationError = useCallback(
    (title: string, error: unknown, fallback: string) => {
      toast({
        variant: "destructive",
        title,
        description: readErrorMessage(error, fallback)
      });
    },
    []
  );

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

  const workspaceGitStatusQuery = useQuery({
    queryKey: queryKey("workspaceGitStatus", selection.selectedWorkspaceId),
    queryFn: async (): Promise<WorkspaceGitStatusData | null> => {
      if (selection.selectedWorkspaceId === "all") {
        return null;
      }
      const workspace = workspacesQuery.data?.find(
        (w) => w.id === selection.selectedWorkspaceId
      );
      if (!workspace?.isGitRepo) {
        return null;
      }
      return api.getWorkspaceGitStatus(selection.selectedWorkspaceId);
    },
    enabled:
      selection.selectedWorkspaceId !== "all" &&
      workspacesQuery.isSuccess,
    refetchInterval: 30_000
  });

  const pullWorkspaceMutation = useMutation({
    mutationFn: async (workspaceId: string) => {
      return api.pullWorkspace(workspaceId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKey("workspaceGitStatus")
      });
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't pull latest changes",
        error,
        "Unable to pull the selected workspace."
      );
    }
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
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: queryKey("workspaces") });
      toast({
        title: "Workspace added",
        description: `${workspace.name} is ready in Workhorse.`
      });
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't create workspace",
        error,
        "Unable to create workspace."
      );
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
    },
    onError: (error) => {
      notifyMutationError("Couldn't create task", error, "Unable to create task.");
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
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: queryKey("workspaces") });
      toast({
        title: "Workspace settings saved",
        description: `${workspace.name} was updated successfully.`
      });
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't save workspace settings",
        error,
        "Unable to update workspace settings."
      );
    }
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (body: UpdateSettingsBody) => {
      const response = await api.updateSettings(body);
      return response.settings;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("settings") });
      toast({
        title: "Global settings saved",
        description: "Workhorse will use the updated global defaults."
      });
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't save global settings",
        error,
        "Unable to update global settings."
      );
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
    onError: async (error, _variables, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(queryKey("tasks"), context.previousTasks);
      }

      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      await queryClient.invalidateQueries({ queryKey: queryKey("runs") });
      notifyMutationError("Couldn't start task", error, "Unable to start task.");
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
    },
    onError: (error) => {
      notifyMutationError("Couldn't stop task", error, "Unable to stop task.");
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
    },
    onError: (error) => {
      notifyMutationError("Couldn't send input", error, "Unable to send input.");
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
    onError: (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey("tasks"), context.previous);
      }
      notifyMutationError("Couldn't update task", error, "Unable to update task.");
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
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't start planning",
        error,
        "Unable to start the planning run."
      );
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
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't send plan feedback",
        error,
        "Unable to send plan feedback."
      );
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
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't request review",
        error,
        "Unable to start an agent review."
      );
    }
  });

  const approveTaskMutation = useMutation({
    mutationFn: async ({ taskId }: { taskId: string }) => {
      const response = await api.approveTask(taskId);
      return response.task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't approve task",
        error,
        "Unable to approve the selected task."
      );
    }
  });

  const rejectTaskMutation = useMutation({
    mutationFn: async ({
      taskId,
      reason
    }: {
      taskId: string;
      reason?: string;
    }) => {
      const response = await api.rejectTask(taskId, { reason });
      return response.task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't reject task",
        error,
        "Unable to reject the selected task."
      );
    }
  });

  const retryTaskMutation = useMutation({
    mutationFn: async ({ taskId }: { taskId: string }) => {
      const response = await api.retryTask(taskId);
      return response.task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      await queryClient.invalidateQueries({ queryKey: queryKey("runs") });
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't retry task",
        error,
        "Unable to retry the selected task."
      );
    }
  });

  const cancelSubtaskMutation = useMutation({
    mutationFn: async ({ taskId }: { taskId: string; workspaceId: string }) => {
      const response = await api.stopTask(taskId);
      return response.task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      await queryClient.invalidateQueries({ queryKey: queryKey("runs") });
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't cancel subtask",
        error,
        "Unable to cancel the selected subtask."
      );
    }
  });

  const cleanupTaskWorktreeMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await api.cleanupTaskWorktree(taskId);
      return response.task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't clean up worktree",
        error,
        "Unable to clean up the task worktree."
      );
    }
  });

  const changeColumnMutation = useMutation({
    mutationFn: async ({ taskId, column }: { taskId: string; column: TaskColumn }) => {
      const response = await api.updateTask(taskId, { column });
      return response.task;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't move task",
        error,
        "Unable to update the task column."
      );
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
    },
    onError: (error) => {
      notifyMutationError(
        "Couldn't delete workspace",
        error,
        "Unable to delete the selected workspace."
      );
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
    },
    onError: (error) => {
      notifyMutationError("Couldn't delete task", error, "Unable to delete the selected task.");
    }
  });

  const schedulerStatusQuery = useQuery({
    queryKey: queryKey("schedulerStatus"),
    queryFn: async () => api.getSchedulerStatus(),
    refetchInterval: 15_000
  });

  const setTaskDependenciesMutation = useMutation({
    mutationFn: async ({ taskId, dependencies }: { taskId: string; dependencies: string[] }) => {
      const response = await api.setTaskDependencies(taskId, dependencies);
      return response.task;
    },
    onMutate: async ({ taskId, dependencies }) => {
      await queryClient.cancelQueries({ queryKey: queryKey("tasks") });
      const previous = queryClient.getQueryData<Task[]>(queryKey("tasks"));
      if (previous) {
        queryClient.setQueryData<Task[]>(
          queryKey("tasks"),
          previous.map((task) => (task.id === taskId ? { ...task, dependencies } : task))
        );
      }
      return { previous };
    },
    onError: async (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey("tasks"), context.previous);
      }
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
      notifyMutationError(
        "Couldn't save dependencies",
        error,
        "Unable to update task dependencies."
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey("tasks") });
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
    workspaceGitStatus: workspaceGitStatusQuery.data ?? null,
    pullWorkspace: pullWorkspaceMutation.mutateAsync,
    isPulling: pullWorkspaceMutation.isPending,
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
    globalSettingsModalOpen: modals.globalSettingsModalOpen,
    taskModalOpen: modals.taskModalOpen,
    setWorkspaceModalOpen: modals.setWorkspaceModalOpen,
    setGlobalSettingsModalOpen: modals.setGlobalSettingsModalOpen,
    setTaskModalOpen: modals.setTaskModalOpen,
    sidebarCollapsed: selection.sidebarCollapsed,
    toggleSidebarCollapsed: selection.toggleSidebarCollapsed,
    setSidebarCollapsed: selection.setSidebarCollapsed,
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
    approveTask: approveTaskMutation.mutateAsync,
    rejectTask: rejectTaskMutation.mutateAsync,
    retryTask: retryTaskMutation.mutateAsync,
    cancelSubtask: cancelSubtaskMutation.mutateAsync,
    planTask: planTaskMutation.mutateAsync,
    sendPlanFeedback: sendPlanFeedbackMutation.mutateAsync,
    requestTaskReview: requestTaskReviewMutation.mutateAsync,
    cleanupTaskWorktree: cleanupTaskWorktreeMutation.mutateAsync,
    moveToTodo: (taskId: string) => changeColumnMutation.mutateAsync({ taskId, column: "todo" }),
    markDone: (taskId: string) => changeColumnMutation.mutateAsync({ taskId, column: "done" }),
    archiveTask: (taskId: string) => changeColumnMutation.mutateAsync({ taskId, column: "archived" }),
    deleteWorkspace: deleteWorkspaceMutation.mutateAsync,
    deleteTask: deleteTaskMutation.mutateAsync,
    schedulerStatus: schedulerStatusQuery.data ?? null,
    setTaskDependencies: setTaskDependenciesMutation.mutateAsync,
    isBusy: [
      createWorkspaceMutation,
      updateSettingsMutation,
      updateWorkspaceMutation,
      createTaskMutation,
      startTaskMutation,
      stopTaskMutation,
      sendTaskInputMutation,
      updateTaskMutation,
      approveTaskMutation,
      rejectTaskMutation,
      retryTaskMutation,
      cancelSubtaskMutation,
      planTaskMutation,
      sendPlanFeedbackMutation,
      requestTaskReviewMutation,
      cleanupTaskWorktreeMutation,
      changeColumnMutation,
      deleteWorkspaceMutation,
      deleteTaskMutation,
      pullWorkspaceMutation,
      setTaskDependenciesMutation
    ].some((m) => m.isPending)
  };
}
