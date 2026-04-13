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
import { Sidebar } from "@/components/Sidebar";
import { TaskDetailsPanel } from "@/components/TaskDetailsPanel";
import { TeamManagementModal } from "@/components/TeamManagementModal";
import {
  GlobalSettingsModal,
  TaskModal,
  WorkspaceModal,
  WorkspaceSettingsModal
} from "@/components/WorkspaceModals";
import { TopBar } from "@/components/TopBar";
import { useBoardData } from "@/hooks/useBoardData";
import { api } from "@/lib/api";
import { useWorkspaceSocket } from "@/hooks/useWorkspaceSocket";
import { resolveRunSelectionAfterStart } from "@/lib/run-selection";
import { isBoardVisibleColumn, type DisplayTaskColumn } from "@/lib/task-view";
import { queryClient } from "@/lib/query";
import { applyTheme, getPreferredTheme, type ThemeMode } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { prepareLiveLogEntries } from "@/components/live-log-entries";
import {
  teamQueryKeys,
  usePostTeamMessage,
  useTeam,
  useTeamMessages
} from "@/hooks/useTeams";

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
  const { selectedWorkspaceTasks, displayedTasks, workspacesQuery, teams } = board;

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
        case "team.updated":
          queryClient.invalidateQueries({ queryKey: teamQueryKeys.lists() });
          queryClient.invalidateQueries({
            queryKey: teamQueryKeys.detail(event.teamId)
          });
          break;
        case "team.agent.message":
          queryClient.invalidateQueries({
            queryKey: teamQueryKeys.messages(event.teamId, event.parentTaskId)
          });
          break;
        case "team.task.created":
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          queryClient.invalidateQueries({
            queryKey: teamQueryKeys.messages(event.teamId, event.parentTaskId)
          });
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
  const teamNames = useMemo(() => {
    return new Map(teams.map((team) => [team.id, team.name]));
  }, [teams]);
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
      const teamName = task.teamId ? teamNames.get(task.teamId) ?? "" : "";
      return [task.title, task.description, workspaceName, teamName, task.runnerType, task.column]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [searchQuery, teamNames, visibleBoardTasks, workspaceNames]);

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

  const isTaskDetailView = location.pathname.startsWith("/tasks/");

  return (
    <div className="grid h-screen min-h-screen grid-cols-[auto_1fr] overflow-hidden">
      <Sidebar
        workspaces={workspaces}
        allTasks={allTasks}
        teamCount={teams.length}
        selectedWorkspaceId={board.selectedWorkspaceId}
        collapsed={board.sidebarCollapsed}
        onToggleCollapse={board.toggleSidebarCollapsed}
        onSelectWorkspace={board.setWorkspaceSelection}
        onAddWorkspace={() => board.setWorkspaceModalOpen(true)}
        onOpenTeams={() => board.setTeamModalOpen(true)}
        onOpenWorkspaceSettings={() => board.setWorkspaceSettingsModalOpen(true)}
        onOpenGlobalSettings={() => board.setGlobalSettingsModalOpen(true)}
      />

      <main
        className={
          isTaskDetailView
            ? "relative z-[1] grid min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden p-0"
            : "relative z-[1] grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0"
        }
      >
        {isTaskDetailView ? null : <TopBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onCreateTask={() => board.setTaskModalOpen(true)}
          onRefresh={() => {
            void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
            void queryClient.invalidateQueries({ queryKey: ["tasks"] });
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
            if (board.selectedWorkspaceId !== "all") {
              void board.pullWorkspace(board.selectedWorkspaceId);
            }
          }}
          isPulling={board.isPulling}
          selectedWorkspaceName={selectedWorkspaceName}
          schedulerStatus={board.schedulerStatus}
        />}

        <Routes>
          <Route
            path="/"
            element={
              <DragDropContext onDragEnd={handleDrop}>
                <Board
                  tasks={boardTasks}
                  allTasks={allTasks}
                  teams={teams}
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
        teams={teams}
        selectedWorkspaceId={board.selectedWorkspaceId}
        settings={board.settingsQuery.data ?? null}
        submitting={board.isCreatingTask}
        onClose={() => board.setTaskModalOpen(false)}
        onSubmit={(values) => {
          return board.createTask(values).then(() => undefined);
        }}
      />

      <TeamManagementModal
        open={board.teamModalOpen}
        teams={teams}
        workspaces={workspaces}
        selectedWorkspaceId={board.selectedWorkspaceId}
        loading={board.teamsQuery.isLoading}
        error={
          board.teamsQuery.error instanceof Error
            ? board.teamsQuery.error.message
            : null
        }
        submitting={board.isSavingTeam}
        onClose={() => board.setTeamModalOpen(false)}
        onCreateTeam={(values) => board.createTeam(values)}
        onUpdateTeam={(teamId, values) =>
          board.updateTeamData({
            teamId,
            body: {
              name: values.name,
              description: values.description,
              prStrategy: values.prStrategy,
              agents: values.agents
            }
          })
        }
        onDeleteTeam={(teamId) => board.deleteTeam(teamId)}
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
  const teamThreadTaskId = task ? task.parentTaskId ?? task.id : null;
  const team = useTeam(task?.teamId ?? null);
  const teamMessages = useTeamMessages(
    task?.teamId ?? null,
    teamThreadTaskId ?? undefined
  );
  const postTeamMessage = usePostTeamMessage(task?.teamId ?? null, teamThreadTaskId);
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

      return (await api.getRunLog(viewedRunId)).items;
    },
    enabled: isSelectedTaskActive && Boolean(viewedRunId)
  });
  const runLog = runLogQuery.data ?? [];

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

  return (
    <section className="flex h-full min-h-0 w-full">
      <TaskDetailsPanel
        className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
        task={task}
        allTasks={allTasks}
        runs={runs}
        workspaces={workspaces}
        team={team.data ?? null}
        teamMessages={teamMessages.data ?? []}
        teamMessagesLoading={teamMessages.isLoading}
        teamMessagesError={
          teamMessages.error instanceof Error ? teamMessages.error.message : null
        }
        selectedRunId={board.selectedRunId}
        runLogLoading={runLogQuery.isLoading}
        onBack={() => navigate("/")}
        onSelectRun={board.setSelectedRunId}
        liveLog={liveLog}
        runLog={runLog}
        onPlan={() => board.planTask(task.id)}
        onSendPlanFeedback={(text) => board.sendPlanFeedback({ taskId: task.id, text })}
        onSendTeamMessage={(text) => postTeamMessage.mutateAsync(text)}
        onStart={() => board.startTask(task.id)}
        onRequestReview={() => board.requestTaskReview(task.id)}
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
    <section className="flex min-h-[60vh] flex-1 flex-col items-center justify-center bg-[var(--bg)] p-4">
      <div className="grid max-w-[32rem] gap-3 text-center">
        <p className="m-0 font-mono text-[0.64rem] uppercase tracking-[0.14em] text-[var(--accent)]">
          {eyebrow}
        </p>
        <h2>{title}</h2>
        <p className="m-0 text-[var(--muted)]">{description}</p>
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
