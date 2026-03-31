import { useCallback, useEffect, useMemo, useState } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import type { ServerEvent, TaskColumn } from "@workhorse/contracts";

import { Board } from "@/components/Board";
import { TaskDetailsPanel } from "@/components/TaskDetailsPanel";
import { TaskModal, WorkspaceModal } from "@/components/WorkspaceModals";
import { TopBar } from "@/components/TopBar";
import { useBoardData } from "@/hooks/useBoardData";
import { useWorkspaceSocket } from "@/hooks/useWorkspaceSocket";
import { queryClient } from "@/lib/query";

export default function App() {
  return (
    <ReactAppShell />
  );
}

function ReactAppShell() {
  const board = useBoardData();
  const [syncedAt, setSyncedAt] = useState<string>(new Date().toISOString());
  const {
    selectedTask,
    selectedWorkspaceTasks,
    selectedWorkspaceId,
    workspacesQuery,
    selectedTaskRunsQuery,
    selectedRun,
    selectedRunLogQuery,
    liveLogByRunId
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

  useEffect(() => {
    if (!selectedTask && selectedWorkspaceTasks[0]) {
      board.setTaskSelection(selectedWorkspaceTasks[0].id);
    }
  }, [board, selectedTask, selectedWorkspaceTasks]);

  const workspaces = workspacesQuery.data ?? [];
  const tasks = selectedWorkspaceTasks;
  const runs = selectedTaskRunsQuery.data ?? [];
  const liveLog = selectedRun?.id ? liveLogByRunId[selectedRun.id] ?? "" : "";
  const runLog = selectedRunLogQuery.data ?? "";

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

    const task = tasks.find((item) => item.id === result.draggableId);
    if (!task) {
      return;
    }

    const destinationColumn = result.destination.droppableId as TaskColumn;
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

    void board.updateTask({
      taskId: task.id,
      body: {
        column: destinationColumn,
        order
      }
    });
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <main className="app">
        <TopBar
          workspaces={workspaces}
          selectedWorkspaceId={board.selectedWorkspaceId}
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
        />

        <div className="workspace-banner">
          <span>Showing {selectedWorkspaceName}</span>
          <span>{board.healthQuery.data?.status ?? "connecting"}</span>
        </div>

        <DragDropContext onDragEnd={handleDrop}>
          <Board
            tasks={tasks}
            workspaces={workspaces}
            selectedTaskId={selectedTask?.id ?? null}
            onTaskSelect={board.setTaskSelection}
            onTaskStart={(taskId) => board.startTask(taskId)}
            onTaskStop={(taskId) => board.stopTask(taskId)}
          />
        </DragDropContext>

        <TaskDetailsPanel
          task={selectedTask}
          runs={runs}
          workspaces={workspaces}
          selectedRunId={board.selectedRunId}
          onSelectRun={board.setSelectedRunId}
          liveLog={liveLog}
          runLog={runLog}
          onStart={() => selectedTask && board.startTask(selectedTask.id)}
          onStop={() => selectedTask && board.stopTask(selectedTask.id)}
          onDelete={() => selectedTask && board.deleteTask(selectedTask.id)}
        />
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
