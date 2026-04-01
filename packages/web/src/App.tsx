import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from "react-router-dom";
import type { RunLogEntry, ServerEvent, Workspace } from "@workhorse/contracts";

import { Board } from "@/components/Board";
import { TaskDetailsPanel } from "@/components/TaskDetailsPanel";
import {
  TaskModal,
  WorkspaceModal,
  WorkspaceSettingsModal
} from "@/components/WorkspaceModals";
import { TopBar } from "@/components/TopBar";
import { useBoardData } from "@/hooks/useBoardData";
import { api } from "@/lib/api";
import { useWorkspaceSocket } from "@/hooks/useWorkspaceSocket";
import { resolveRunSelectionAfterStart } from "@/lib/run-selection";
import type { DisplayTaskColumn } from "@/lib/task-view";
import { queryClient } from "@/lib/query";
import { applyTheme, getPreferredTheme, type ThemeMode } from "@/lib/theme";

export default function App() {
  return <ReactAppShell />;
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
  const { selectedWorkspaceTasks, displayedTasks, workspacesQuery } = board;

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
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          queryClient.invalidateQueries({ queryKey: ["runs"] });
          queryClient.invalidateQueries({ queryKey: ["health"] });
          break;
        case "runtime.review-monitor.polled":
          setReviewMonitorLastPolledAt(event.polledAt);
          break;
        default:
          break;
      }
    },
    [board]
  );

  useWorkspaceSocket({ onEvent: handleEvent });

  const workspaces = workspacesQuery.data ?? [];
  const tasks = selectedWorkspaceTasks;
  const allTasks = displayedTasks;
  const workspaceNames = useMemo(() => {
    return new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  }, [workspaces]);

  const boardTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return tasks;
    }

    return tasks.filter((task) => {
      const workspaceName = workspaceNames.get(task.workspaceId) ?? "";
      return [task.title, task.description, workspaceName, task.runnerType, task.column]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [searchQuery, tasks, workspaceNames]);

  const selectedWorkspaceName = useMemo(() => {
    if (board.selectedWorkspaceId === "all") {
      return "All workspaces";
    }
    return (
      workspaces.find((workspace) => workspace.id === board.selectedWorkspaceId)?.name ??
      "All workspaces"
    );
  }, [board.selectedWorkspaceId, workspaces]);
  const selectedWorkspace = useMemo(() => {
    if (board.selectedWorkspaceId === "all") {
      return null;
    }

    return workspaces.find((workspace) => workspace.id === board.selectedWorkspaceId) ?? null;
  }, [board.selectedWorkspaceId, workspaces]);
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
      void board.startTask(task.id);
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

  return (
    <div className="app-shell">
      <main
        className={
          location.pathname.startsWith("/tasks/") ? "app app-details" : "app app-board"
        }
      >
        <TopBar
          workspaces={workspaces}
          selectedWorkspaceId={board.selectedWorkspaceId}
          selectedWorkspaceName={selectedWorkspaceName}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onWorkspaceChange={board.setWorkspaceSelection}
          onCreateWorkspace={() => board.setWorkspaceModalOpen(true)}
          onOpenWorkspaceSettings={() => board.setWorkspaceSettingsModalOpen(true)}
          onCreateTask={() => board.setTaskModalOpen(true)}
          onRefresh={() => {
            void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
            void queryClient.invalidateQueries({ queryKey: ["tasks"] });
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
        />

        <Routes>
          <Route
            path="/"
            element={
              <DragDropContext onDragEnd={handleDrop}>
                <Board
                  tasks={boardTasks}
                  workspaces={workspaces}
                  reviewMonitor={reviewMonitor}
                  selectedTaskId={board.selectedTask?.id ?? null}
                  onTaskOpen={openTask}
                  onPlan={(taskId) => board.planTask(taskId)}
                  onTaskStart={(taskId) => board.startTask(taskId)}
                  onTaskStop={(taskId) => board.stopTask(taskId)}
                  onMoveToTodo={(taskId) => board.moveToTodo(taskId)}
                  onMarkDone={(taskId) => board.markDone(taskId)}
                  onArchive={(taskId) => board.archiveTask(taskId)}
                />
              </DragDropContext>
            }
          />
          <Route
            path="/tasks/:taskId"
            element={
              <TaskDetailsRoute board={board} allTasks={allTasks} workspaces={workspaces} />
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
      <WorkspaceSettingsModal
        open={board.workspaceSettingsModalOpen}
        workspace={selectedWorkspace}
        taskCount={selectedWorkspaceTaskCount}
        onClose={() => board.setWorkspaceSettingsModalOpen(false)}
        onSubmit={(values) => {
          if (!selectedWorkspace) {
            return;
          }

          void board
            .updateWorkspace({
              workspaceId: selectedWorkspace.id,
              body: values
            })
            .then(() => {
              board.setWorkspaceSettingsModalOpen(false);
            });
        }}
      />

      <TaskModal
        open={board.taskModalOpen}
        workspaces={workspaces}
        selectedWorkspaceId={board.selectedWorkspaceId}
        onClose={() => board.setTaskModalOpen(false)}
        onSubmit={(values) => {
          void board.createTask(values);
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
}

function TaskDetailsRoute({
  board,
  allTasks,
  workspaces
}: TaskDetailsRouteProps) {
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();

  useEffect(() => {
    if (taskId && board.selectedTask?.id !== taskId) {
      board.setTaskSelection(taskId);
    }
  }, [board.selectedTask?.id, board.setTaskSelection, taskId]);

  const task = taskId ? allTasks.find((entry) => entry.id === taskId) ?? null : null;
  const isSelectedTaskActive = task ? board.selectedTask?.id === task.id : false;
  const runs = isSelectedTaskActive ? board.selectedTaskRunsQuery.data ?? [] : [];
  const activeRunId = isSelectedTaskActive ? board.activeRunId : null;
  const viewedRunId = isSelectedTaskActive ? board.viewedRunId : null;
  const liveLog =
    activeRunId && viewedRunId === activeRunId ? board.liveLogByRunId[activeRunId] ?? [] : [];
  const workspaceName = task
    ? workspaces.find((workspace) => workspace.id === task.workspaceId)?.name ?? "Unknown workspace"
    : "Unknown workspace";
  const runLogQuery = useQuery({
    queryKey: ["run-log", viewedRunId ?? ""],
    queryFn: async (): Promise<RunLogEntry[]> => {
      if (!viewedRunId) {
        return [];
      }

      return (await api.getRunLog(viewedRunId)).data.items;
    },
    enabled: isSelectedTaskActive && Boolean(viewedRunId)
  });
  const runLog = runLogQuery.data ?? [];

  if (!taskId) {
    return <Navigate to="/" replace />;
  }

  if (board.tasksQuery.isLoading) {
    return (
      <section className="details-page-shell">
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
      <section className="details-page-shell">
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

  return (
    <section className="details-page-shell">
      <TaskDetailsPanel
        className="details-panel-page"
        task={task}
        runs={runs}
        workspaces={workspaces}
        selectedRunId={board.selectedRunId}
        runLogLoading={runLogQuery.isLoading}
        onBack={() => navigate("/")}
        onSelectRun={board.setSelectedRunId}
        liveLog={liveLog}
        runLog={runLog}
        onPlan={() => board.planTask(task.id)}
        onStart={() => board.startTask(task.id)}
        onStop={() => board.stopTask(task.id)}
        onSendInput={(text) => board.sendTaskInput({ taskId: task.id, text })}
        onMoveToTodo={() => board.moveToTodo(task.id)}
        onMarkDone={() => board.markDone(task.id)}
        onArchive={() => board.archiveTask(task.id)}
        onCleanupWorktree={() => board.cleanupTaskWorktree(task.id)}
        onDelete={async () => {
          await board.deleteTask(task.id);
          navigate("/");
        }}
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
    <section className="details-panel details-panel-page empty-panel">
      <div className="empty-state">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{description}</p>
        <button
          type="button"
          className="button button-secondary empty-state-action"
          onClick={onAction}
        >
          {actionLabel}
        </button>
      </div>
    </section>
  );
}
