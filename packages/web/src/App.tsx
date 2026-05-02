import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import {
  Navigate,
  Route,
  Routes,
  matchPath,
  useLocation,
  useNavigate,
  useParams
} from "react-router-dom";
import type {
  Message,
  RunLogEntry,
  ServerEvent,
  Thread,
  Workspace,
  WorkspaceAgent
} from "@workhorse/contracts";

import { Board } from "@/components/Board";
import { Sidebar } from "@/components/Sidebar";
import { TaskDetailsPanel } from "@/components/TaskDetailsPanel";
import { AgentsPage } from "@/components/AgentsPage";
import { AgentEditPage } from "@/components/AgentEditPage";
import { ThreadPage } from "@/components/ThreadPage";
import {
  GlobalSettingsModal,
  TaskModal,
  WorkspaceModal
} from "@/components/WorkspaceModals";
import { WorkspaceSettingsPage } from "@/components/WorkspaceSettingsPage";
import { TopBar } from "@/components/TopBar";
import { useBoardData } from "@/hooks/useBoardData";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { api } from "@/lib/api";
import { useWorkspaceSocket } from "@/hooks/useWorkspaceSocket";
import { resolveRunSelectionAfterStart } from "@/lib/run-selection";
import { isBoardVisibleColumn, type DisplayTaskColumn } from "@/lib/task-view";
import { upsertThreadMessage } from "@/lib/thread-messages";
import { queryClient } from "@/lib/query";
import { applyTheme, getPreferredTheme, type ThemeMode } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { prepareLiveLogEntries } from "@/components/live-log-entries";
import { useAgents, workspaceAgentQueryKeys } from "@/hooks/useAgents";
import { threadQueryKeys } from "@/hooks/useThreads";

export default function App() {
  return <ReactAppShell />;
}

function workspaceBoardPath(workspaceId: string | "all"): string {
  return workspaceId === "all" ? "/" : `/workspaces/${workspaceId}/board`;
}

function workspaceThreadPath(workspaceId: string, threadId: string): string {
  return `/workspaces/${workspaceId}/threads/${threadId}`;
}

function ReactAppShell() {
  const board = useBoardData();
  const location = useLocation();
  const navigate = useNavigate();
  const [syncedAt, setSyncedAt] = useState<string>(new Date().toISOString());
  const [reviewMonitorLastPolledAt, setReviewMonitorLastPolledAt] = useState<
    string | undefined
  >();
  const [searchQuery, setSearchQuery] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(() => getPreferredTheme());
  const { displayedTasks, workspacesQuery } = board;
  const agentsQuery = useAgents();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const lastPolledAt = board.healthQuery.data?.reviewMonitor.lastPolledAt;
    if (!lastPolledAt) {
      return;
    }

    setReviewMonitorLastPolledAt((current) => {
      if (!current) {
        return lastPolledAt;
      }

      return Date.parse(lastPolledAt) > Date.parse(current) ? lastPolledAt : current;
    });
  }, [board.healthQuery.data?.reviewMonitor.lastPolledAt]);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      board.recordLiveOutput(event);
      setSyncedAt(new Date().toISOString());

      switch (event.type) {
        case "workspace.updated":
          queryClient.invalidateQueries({ queryKey: ["workspaces"] });
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          break;
        case "task.updated":
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          break;
        case "run.started":
          if (event.taskId === board.selectedTask?.id) {
            board.setSelectedRunId((current) =>
              resolveRunSelectionAfterStart({
                selectedRunId: current,
                previousLastRunId: board.selectedTask?.lastRunId,
                startedRunId: event.run.id
              })
            );
          }
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          queryClient.invalidateQueries({ queryKey: ["runs"] });
          queryClient.invalidateQueries({ queryKey: ["health"] });
          break;
        case "run.finished":
          if (board.viewedRunId === event.run.id) {
            queryClient.setQueryData<RunLogEntry[]>(["run-log", event.run.id], (current) => {
              const liveEntries = board.liveLogByRunId[event.run.id] ?? [];
              if (liveEntries.length === 0) {
                return current;
              }

              return prepareLiveLogEntries([...(current ?? []), ...liveEntries]);
            });
          }
          board.clearLiveOutput(event.run.id);
          queryClient.invalidateQueries({ queryKey: ["run-log", event.run.id] });
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          queryClient.invalidateQueries({ queryKey: ["runs"] });
          queryClient.invalidateQueries({ queryKey: ["health"] });
          break;
        case "runtime.review-monitor.polled":
          setReviewMonitorLastPolledAt(event.polledAt);
          break;
        case "agent.updated":
          queryClient.invalidateQueries({ queryKey: ["agents"] });
          queryClient.invalidateQueries({ queryKey: workspaceAgentQueryKeys.lists() });
          break;
        case "workspace.agent.updated":
          queryClient.invalidateQueries({
            queryKey: workspaceAgentQueryKeys.list(event.workspaceId)
          });
          break;
        case "thread.updated":
          queryClient.invalidateQueries({ queryKey: threadQueryKeys.lists() });
          break;
        case "thread.message":
          if (queryClient.getQueryState<Message[]>(threadQueryKeys.messages(event.threadId))?.data) {
            queryClient.setQueryData<Message[]>(
              threadQueryKeys.messages(event.threadId),
              (current) =>
                current ? upsertThreadMessage(current, event.message) : current
            );
          } else {
            queryClient.invalidateQueries({
              queryKey: threadQueryKeys.messages(event.threadId)
            });
          }
          break;
        default:
          break;
      }
    },
    [board]
  );

  useWorkspaceSocket({ onEvent: handleEvent });

  const workspaces = workspacesQuery.data ?? [];
  const accountAgents = agentsQuery.data ?? [];
  const workspaceAgentQueries = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: workspaceAgentQueryKeys.list(workspace.id),
      queryFn: async () => (await api.listWorkspaceAgents(workspace.id)).items,
      enabled: workspaces.length > 0
    }))
  });
  const workspaceAgentsByWorkspaceId = useMemo(() => {
    const map = new Map<string, WorkspaceAgent[]>();
    for (const [index, workspace] of workspaces.entries()) {
      map.set(workspace.id, workspaceAgentQueries[index]?.data ?? []);
    }
    return map;
  }, [workspaceAgentQueries, workspaces]);
  const workspaceThreadQueries = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: threadQueryKeys.list(workspace.id),
      queryFn: async () => (await api.listWorkspaceThreads(workspace.id)).items,
      enabled: workspaces.length > 0
    }))
  });
  const workspaceThreadsByWorkspaceId = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const [index, workspace] of workspaces.entries()) {
      map.set(workspace.id, workspaceThreadQueries[index]?.data ?? []);
    }
    return map;
  }, [workspaceThreadQueries, workspaces]);
  const routeWorkspaceMatch = matchPath("/workspaces/:workspaceId/*", location.pathname);
  const routeThreadMatch = matchPath(
    "/workspaces/:workspaceId/threads/:threadId",
    location.pathname
  );
  const routeSelectedWorkspaceId =
    routeWorkspaceMatch?.params.workspaceId ?? (location.pathname === "/" ? "all" : null);
  const activeWorkspaceId = routeSelectedWorkspaceId ?? board.selectedWorkspaceId;
  const activeThreadId = routeThreadMatch?.params.threadId ?? null;

  const tasks =
    activeWorkspaceId === "all"
      ? displayedTasks
      : displayedTasks.filter((task) => task.workspaceId === activeWorkspaceId);
  const allTasks = displayedTasks;
  const workspaceNames = useMemo(() => {
    return new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  }, [workspaces]);
  const visibleBoardTasks = useMemo(
    () => tasks.filter((task) => isBoardVisibleColumn(task.column)),
    [tasks]
  );

  const boardTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return visibleBoardTasks;
    }

    return visibleBoardTasks.filter((task) => {
      const workspaceName = workspaceNames.get(task.workspaceId) ?? "";
      const coordinationTag =
        task.parentTaskId ||
        (workspaceAgentsByWorkspaceId.get(task.workspaceId) ?? []).some(
          (agent) => agent.role === "coordinator"
        )
          ? "agents coordination"
          : "";
      return [task.title, task.description, workspaceName, coordinationTag, task.column]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [searchQuery, visibleBoardTasks, workspaceAgentsByWorkspaceId, workspaceNames]);

  const selectedWorkspaceName = useMemo(() => {
    if (activeWorkspaceId === "all") {
      return "All workspaces";
    }
    return (
      workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.name ??
      "All workspaces"
    );
  }, [activeWorkspaceId, workspaces]);
  const selectedWorkspace = useMemo(() => {
    if (activeWorkspaceId === "all") {
      return null;
    }

    return workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  }, [activeWorkspaceId, workspaces]);
  const columnVisibility = useColumnVisibility(activeWorkspaceId ?? "all");
  const selectedWorkspaceTaskCount = useMemo(() => {
    if (!selectedWorkspace) {
      return 0;
    }

    return allTasks.filter((task) => task.workspaceId === selectedWorkspace.id).length;
  }, [allTasks, selectedWorkspace]);

  const reviewMonitor = useMemo(
    () => ({
      intervalMs: board.healthQuery.data?.reviewMonitor.intervalMs ?? 0,
      lastPolledAt:
        reviewMonitorLastPolledAt ?? board.healthQuery.data?.reviewMonitor.lastPolledAt
    }),
    [
      board.healthQuery.data?.reviewMonitor.intervalMs,
      board.healthQuery.data?.reviewMonitor.lastPolledAt,
      reviewMonitorLastPolledAt
    ]
  );

  useEffect(() => {
    if (activeWorkspaceId !== board.selectedWorkspaceId) {
      board.setWorkspaceSelection(activeWorkspaceId);
    }
  }, [activeWorkspaceId, board.selectedWorkspaceId, board.setWorkspaceSelection]);

  function handleDrop(result: DropResult) {
    if (!result.destination) {
      return;
    }

    if (
      result.destination.droppableId === result.source.droppableId &&
      result.destination.index === result.source.index
    ) {
      return;
    }

    const task = boardTasks.find((item) => item.id === result.draggableId);
    if (!task) {
      return;
    }

    const destinationColumn = result.destination.droppableId as DisplayTaskColumn;

    const destinationTasks = boardTasks
      .filter((item) => item.column === destinationColumn && item.id !== task.id)
      .sort((left, right) => left.order - right.order);

    const before = destinationTasks[result.destination.index - 1];
    const after = destinationTasks[result.destination.index];
    const order =
      before && after
        ? (before.order + after.order) / 2
        : before
          ? before.order + 1024
          : after
            ? after.order - 1024
            : 1024;

    const body: Record<string, unknown> = { order };
    if (destinationColumn === "running" && task.column !== "running") {
      void board.startTask(task.id, { order });
      return;
    }

    if (destinationColumn !== task.column) {
      body.column = destinationColumn;
    }

    void board.updateTask({
      taskId: task.id,
      body
    });
  }

  function openTask(taskId: string) {
    board.setTaskSelection(taskId);
    navigate(`/tasks/${taskId}`);
  }

  const boardPage = (
    <section className="min-h-0 overflow-hidden">
      <DragDropContext onDragEnd={handleDrop}>
        <Board
          tasks={boardTasks}
          allTasks={allTasks}
          workspaceAgentsByWorkspaceId={workspaceAgentsByWorkspaceId}
          workspaces={workspaces}
          reviewMonitor={reviewMonitor}
          visibleColumnIds={columnVisibility.visibleColumnIds}
          selectedTaskId={board.selectedTask?.id ?? null}
          onTaskOpen={openTask}
          onPlan={(taskId) => board.planTask(taskId)}
          onTaskStart={(taskId) => board.startTask(taskId)}
          onTaskStop={(taskId) => board.stopTask(taskId)}
          onMoveToTodo={(taskId) => board.moveToTodo(taskId)}
          onMarkDone={(taskId) => board.markDone(taskId)}
          onArchive={(taskId) => board.archiveTask(taskId)}
          onApproveSubtask={(task) => void board.approveTask({ taskId: task.id })}
          onRejectSubtask={(task, reason) =>
            void board.rejectTask({ taskId: task.id, reason })
          }
          onRetrySubtask={(task) => void board.retryTask({ taskId: task.id })}
          onCancelSubtask={(task) =>
            void board.cancelSubtask({
              taskId: task.id,
              workspaceId: task.workspaceId
            })
          }
          reviewActionBusy={board.isBusy}
        />
      </DragDropContext>
    </section>
  );

  const isTaskDetailView = location.pathname.startsWith("/tasks/");
  const isThreadView = Boolean(routeThreadMatch);
  const isAgentsView = location.pathname.startsWith("/agents");
  const isWorkspaceSettingsView = location.pathname === "/workspace-settings";

  return (
    <div
      className={`min-h-screen bg-background text-foreground lg:grid lg:h-screen lg:overflow-hidden ${board.sidebarCollapsed ? "lg:grid-cols-[72px_minmax(0,1fr)]" : "lg:grid-cols-[288px_minmax(0,1fr)]"}`}
    >
      <Sidebar
        workspaces={workspaces}
        allTasks={allTasks}
        workspaceThreadsByWorkspaceId={workspaceThreadsByWorkspaceId}
        agentCount={accountAgents.length}
        selectedWorkspaceId={activeWorkspaceId}
        selectedThreadId={activeThreadId}
        collapsed={board.sidebarCollapsed}
        onToggleCollapse={board.toggleSidebarCollapsed}
        onSelectWorkspace={(workspaceId) => {
          board.setWorkspaceSelection(workspaceId);
          navigate(workspaceBoardPath(workspaceId));
        }}
        onSelectThread={(workspaceId, threadId) => {
          board.setWorkspaceSelection(workspaceId);
          const thread =
            workspaceThreadsByWorkspaceId
              .get(workspaceId)
              ?.find((entry) => entry.id === threadId) ?? null;
          if (thread?.taskId) {
            board.setTaskSelection(thread.taskId);
          }
          navigate(workspaceThreadPath(workspaceId, threadId));
        }}
        onAddWorkspace={() => board.setWorkspaceModalOpen(true)}
        onOpenAgents={() => navigate("/agents")}
        onOpenWorkspaceSettings={() => navigate("/workspace-settings")}
        onOpenGlobalSettings={() => board.setGlobalSettingsModalOpen(true)}
      />

      <main
        className={
          isTaskDetailView || isThreadView
            ? "relative z-[1] h-full min-h-screen min-w-0 overflow-hidden lg:min-h-0"
            : "relative z-[1] grid min-h-screen min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden lg:min-h-0"
        }
      >
        {isTaskDetailView || isThreadView || isAgentsView || isWorkspaceSettingsView ? null : (
          <TopBar
            onCreateTask={() => board.setTaskModalOpen(true)}
            onRefresh={() => {
              void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              void queryClient.invalidateQueries({ queryKey: threadQueryKeys.lists() });
              void queryClient.invalidateQueries({ queryKey: ["settings"] });
              void queryClient.invalidateQueries({ queryKey: ["health"] });
              setSyncedAt(new Date().toISOString());
            }}
            theme={theme}
            onToggleTheme={() =>
              setTheme((current) => (current === "dark" ? "light" : "dark"))
            }
            lastSyncedAt={syncedAt}
            boardCount={boardTasks.length}
            runtimeStatus={board.healthQuery.data?.status ?? "connecting"}
            codexQuota={board.healthQuery.data?.codexQuota}
            gitStatus={board.workspaceGitStatus}
            onPull={() => {
              if (activeWorkspaceId !== "all") {
                void board.pullWorkspace(activeWorkspaceId);
              }
            }}
            isPulling={board.isPulling}
            selectedWorkspaceName={selectedWorkspaceName}
            schedulerStatus={board.schedulerStatus}
            visibleColumnIds={columnVisibility.visibleColumnIds}
            onToggleColumn={columnVisibility.toggle}
            onResetColumns={columnVisibility.reset}
          />
        )}

        <Routes>
          <Route path="/" element={boardPage} />
          <Route
            path="/workspaces/:workspaceId/board"
            element={boardPage}
          />
          <Route
            path="/tasks/:taskId"
            element={
              <TaskDetailsRoute
                board={board}
                allTasks={allTasks}
                workspaces={workspaces}
                workspaceAgentsByWorkspaceId={workspaceAgentsByWorkspaceId}
                workspaceThreadsByWorkspaceId={workspaceThreadsByWorkspaceId}
              />
            }
          />
          <Route
            path="/agents"
            element={
              <AgentsPage
                agents={accountAgents}
                loading={agentsQuery.isLoading}
                error={
                  agentsQuery.error instanceof Error
                    ? agentsQuery.error.message
                    : null
                }
              />
            }
          />
          <Route
            path="/agents/:agentId"
            element={<AgentEditPage />}
          />
          <Route
            path="/workspaces/:workspaceId/threads/:threadId"
            element={
              <ThreadPage
                tasks={allTasks}
                workspaces={workspaces}
              />
            }
          />
          <Route path="/teams/*" element={<Navigate to="/agents" replace />} />
          <Route
            path="/workspace-settings"
            element={
              <WorkspaceSettingsPage
                workspace={selectedWorkspace}
                taskCount={selectedWorkspaceTaskCount}
                onSubmit={async (values) => {
                  if (!selectedWorkspace) {
                    return;
                  }
                  await board.updateWorkspace({
                    workspaceId: selectedWorkspace.id,
                    body: values
                  });
                  navigate(workspaceBoardPath(selectedWorkspace.id));
                }}
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <WorkspaceModal
        open={board.workspaceModalOpen}
        onClose={() => board.setWorkspaceModalOpen(false)}
        onSubmit={(values) => {
          void board.createWorkspace(values).then(() => {
            board.setWorkspaceModalOpen(false);
          });
        }}
      />
      <GlobalSettingsModal
        open={board.globalSettingsModalOpen}
        settings={board.settingsQuery.data ?? null}
        onClose={() => board.setGlobalSettingsModalOpen(false)}
        onSubmit={(values) => {
          void board.updateSettings(values).then(() => {
            board.setGlobalSettingsModalOpen(false);
          });
        }}
      />

      <TaskModal
        open={board.taskModalOpen}
        workspaces={workspaces}
        selectedWorkspaceId={activeWorkspaceId}
        settings={board.settingsQuery.data ?? null}
        submitting={board.isCreatingTask}
        onClose={() => board.setTaskModalOpen(false)}
        onSubmit={(values) => {
          return board.createTask(values).then(() => undefined);
        }}
      />

    </div>
  );
}

type BoardData = ReturnType<typeof useBoardData>;

interface TaskDetailsRouteProps {
  board: BoardData;
  allTasks: BoardData["displayedTasks"];
  workspaces: Workspace[];
  workspaceAgentsByWorkspaceId: Map<string, WorkspaceAgent[]>;
  workspaceThreadsByWorkspaceId: Map<string, Thread[]>;
}

function TaskDetailsRoute({
  board,
  allTasks,
  workspaces,
  workspaceAgentsByWorkspaceId,
  workspaceThreadsByWorkspaceId
}: TaskDetailsRouteProps) {
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();

  useEffect(() => {
    if (taskId && board.selectedTask?.id !== taskId) {
      board.setTaskSelection(taskId);
    }
  }, [board.selectedTask?.id, board.setTaskSelection, taskId]);

  const task = taskId ? allTasks.find((entry) => entry.id === taskId) ?? null : null;
  const workspaceAgents = task
    ? workspaceAgentsByWorkspaceId.get(task.workspaceId) ?? []
    : [];
  const isSelectedTaskActive = task ? board.selectedTask?.id === task.id : false;
  const runs = isSelectedTaskActive ? board.selectedTaskRunsQuery.data ?? [] : [];
  const activeRunId = isSelectedTaskActive ? board.activeRunId : null;
  const viewedRunId = isSelectedTaskActive ? board.viewedRunId : null;
  const liveLog =
    activeRunId && viewedRunId === activeRunId ? board.liveLogByRunId[activeRunId] ?? [] : [];
  const runLogQuery = useQuery({
    queryKey: ["run-log", viewedRunId ?? ""],
    queryFn: async (): Promise<RunLogEntry[]> => {
      if (!viewedRunId) {
        return [];
      }

      return (await api.getRunLog(viewedRunId)).items;
    },
    enabled: isSelectedTaskActive && Boolean(viewedRunId)
  });
  const runLog = runLogQuery.data ?? [];

  async function requestCoordinatorReview() {
    if (!task) return;
    const thread = workspaceThreadsByWorkspaceId
      .get(task.workspaceId)
      ?.find((entry) => entry.kind === "task" && entry.taskId === task.id && !entry.archivedAt);
    if (!thread) {
      return;
    }

    await api.postThreadMessage(thread.id, {
      content: `@coordinator Please choose the appropriate review agent(s) for "${task.title}" based on workspace agent descriptions, then run the needed review(s).`,
      kind: "chat"
    });
    navigate(workspaceThreadPath(task.workspaceId, thread.id));
  }

  if (!taskId) {
    return <Navigate to="/" replace />;
  }

  if (board.tasksQuery.isLoading) {
    return (
      <section className="flex h-full min-h-0 w-full">
        <TaskRouteState
          eyebrow="Task details"
          title="Loading task"
          description="We are pulling the latest task state and run history."
          actionLabel="Back to board"
          onAction={() => navigate("/")}
        />
      </section>
    );
  }

  if (!task) {
    return (
      <section className="flex h-full min-h-0 w-full">
        <TaskRouteState
          eyebrow="Task details"
          title="Task not found"
          description="This task may have been deleted or moved out of the current dataset."
          actionLabel="Back to board"
          onAction={() => navigate("/")}
        />
      </section>
    );
  }

  const isSubtask = Boolean(task.parentTaskId);

  return (
    <section className="flex h-full min-h-0 w-full">
      <TaskDetailsPanel
        className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
        task={task}
        allTasks={allTasks}
        runs={runs}
        workspaces={workspaces}
        workspaceAgents={workspaceAgents}
        selectedRunId={board.selectedRunId}
        runLogLoading={runLogQuery.isLoading}
        onBack={() => navigate(workspaceBoardPath(task.workspaceId))}
        onSelectRun={board.setSelectedRunId}
        liveLog={liveLog}
        runLog={runLog}
        onPlan={() => board.planTask(task.id)}
        onSendPlanFeedback={(text) => board.sendPlanFeedback({ taskId: task.id, text })}
        onApproveSubtask={
          isSubtask ? () => board.approveTask({ taskId: task.id }) : undefined
        }
        onRejectSubtask={
          isSubtask
            ? (reason) => board.rejectTask({ taskId: task.id, reason })
            : undefined
        }
        onRetrySubtask={
          isSubtask ? () => board.retryTask({ taskId: task.id }) : undefined
        }
        onCancelSubtask={
          isSubtask
            ? () =>
                board.cancelSubtask({
                  taskId: task.id,
                  workspaceId: task.workspaceId
                })
            : undefined
        }
        reviewActionBusy={board.isBusy}
        onStart={() => board.startTask(task.id)}
        onRequestReview={() => {
          void requestCoordinatorReview();
        }}
        onStop={() => board.stopTask(task.id)}
        onSendInput={(text) => board.sendTaskInput({ taskId: task.id, text })}
        onMoveToTodo={() => board.moveToTodo(task.id)}
        onMarkDone={() => board.markDone(task.id)}
        onArchive={() => board.archiveTask(task.id)}
        onCleanupWorktree={() => board.cleanupTaskWorktree(task.id)}
        onDelete={async () => {
          if (
            task.worktree.status === "ready" ||
            task.worktree.status === "cleanup_pending"
          ) {
            await board.cleanupTaskWorktree(task.id);
          }
          await board.deleteTask(task.id);
          navigate(workspaceBoardPath(task.workspaceId));
        }}
        onSetDependencies={(ids) => board.setTaskDependencies({ taskId: task.id, dependencies: ids })}
      />
    </section>
  );
}

interface TaskRouteStateProps {
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  onAction(): void;
}

function TaskRouteState({
  eyebrow,
  title,
  description,
  actionLabel,
  onAction
}: TaskRouteStateProps) {
  return (
    <section className="flex min-h-[60vh] flex-1 flex-col items-center justify-center p-4 sm:p-6">
      <div className="surface-card grid max-w-[34rem] gap-4 px-8 py-10 text-center">
        <p className="section-kicker m-0">
          {eyebrow}
        </p>
        <h2 className="text-[2.6rem]">{title}</h2>
        <p className="m-0 text-[1rem] leading-[1.6] text-[var(--muted)]">{description}</p>
        <Button
          type="button"
          variant="secondary"
          className="justify-self-center"
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      </div>
    </section>
  );
}
