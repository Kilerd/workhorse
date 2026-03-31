import { useCallback, useEffect, useMemo, useState } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from "react-router-dom";
import type { ServerEvent, Workspace } from "@workhorse/contracts";

import { Board } from "@/components/Board";
import { TaskDetailsPanel } from "@/components/TaskDetailsPanel";
import { TaskModal, WorkspaceModal } from "@/components/WorkspaceModals";
import { TopBar } from "@/components/TopBar";
import { useBoardData } from "@/hooks/useBoardData";
import { useWorkspaceSocket } from "@/hooks/useWorkspaceSocket";
import type { DisplayTaskColumn } from "@/lib/task-view";
import { queryClient } from "@/lib/query";

export default function App() {
  return (
    <ReactAppShell />
  );
}

function ReactAppShell() {
  const board = useBoardData();
  const location = useLocation();
  const navigate = useNavigate();
  const [syncedAt, setSyncedAt] = useState<string>(new Date().toISOString());
  const {
    selectedWorkspaceTasks,
    displayedTasks,
    workspacesQuery
  } = board;

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
        case "run.finished":
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          queryClient.invalidateQueries({ queryKey: ["runs"] });
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

  const selectedWorkspaceName = useMemo(() => {
    if (board.selectedWorkspaceId === "all") {
      return "All workspaces";
    }
    return workspaces.find((workspace) => workspace.id === board.selectedWorkspaceId)?.name ?? "All workspaces";
  }, [board.selectedWorkspaceId, workspaces]);

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

    const task = tasks.find((item) => item.id === result.draggableId);
    if (!task) {
      return;
    }

    const destinationColumn = result.destination.droppableId as DisplayTaskColumn;

    const destinationTasks = tasks
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
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <main
        className={
          location.pathname.startsWith("/tasks/") ? "app app-details" : "app app-board"
        }
      >
        <TopBar
          workspaces={workspaces}
          selectedWorkspaceId={board.selectedWorkspaceId}
          selectedWorkspaceName={selectedWorkspaceName}
          onWorkspaceChange={board.setWorkspaceSelection}
          onCreateWorkspace={() => board.setWorkspaceModalOpen(true)}
          onCreateTask={() => board.setTaskModalOpen(true)}
          onRefresh={() => {
            void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
            void queryClient.invalidateQueries({ queryKey: ["tasks"] });
            setSyncedAt(new Date().toISOString());
          }}
          lastSyncedAt={syncedAt}
          boardCount={tasks.length}
          runtimeStatus={board.healthQuery.data?.status ?? "connecting"}
        />

        <Routes>
          <Route
            path="/"
            element={
              <DragDropContext onDragEnd={handleDrop}>
                <Board
                  tasks={tasks}
                  workspaces={workspaces}
                  selectedTaskId={null}
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
              <TaskDetailsRoute
                board={board}
                allTasks={allTasks}
                workspaces={workspaces}
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

      <TaskModal
        open={board.taskModalOpen}
        workspaces={workspaces}
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
    if (taskId) {
      board.setTaskSelection(taskId);
    }
  }, [board, taskId]);

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

  const task = allTasks.find((entry) => entry.id === taskId) ?? null;
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

  const isSelectedTaskActive = board.selectedTask?.id === task.id;
  const runs = isSelectedTaskActive ? board.selectedTaskRunsQuery.data ?? [] : [];
  const selectedRun = isSelectedTaskActive ? board.selectedRun : null;
  const liveLog = selectedRun?.id ? board.liveLogByRunId[selectedRun.id] ?? [] : [];
  const runLog = isSelectedTaskActive ? board.selectedRunLogQuery.data ?? [] : [];
  const workspaceName =
    workspaces.find((workspace) => workspace.id === task.workspaceId)?.name ?? "Unknown workspace";

  return (
    <section className="details-page-shell">
      <div className="details-page-header">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => navigate("/")}
        >
          Back to board
        </button>
        <div className="details-page-meta">
          <span className="meta-chip">Workspace {workspaceName}</span>
          <span className={`status status-${task.column}`}>{task.column}</span>
        </div>
      </div>

      <TaskDetailsPanel
        className="details-panel-page"
        task={task}
        runs={runs}
        workspaces={workspaces}
        selectedRunId={board.selectedRunId}
        onSelectRun={board.setSelectedRunId}
        liveLog={liveLog}
        runLog={runLog}
        onPlan={() => board.planTask(task.id)}
        onStart={() => board.startTask(task.id)}
        onStop={() => board.stopTask(task.id)}
        onMoveToTodo={() => board.moveToTodo(task.id)}
        onMarkDone={() => board.markDone(task.id)}
        onArchive={() => board.archiveTask(task.id)}
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
