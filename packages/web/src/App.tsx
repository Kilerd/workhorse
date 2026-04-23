import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  RunLogEntry,
  ServerEvent,
  Task,
  Workspace,
  WorkspaceAgent,
  WorkspaceChannel
} from "@workhorse/contracts";

import { Board } from "@/components/Board";
import { Sidebar } from "@/components/Sidebar";
import { TaskDetailsPanel } from "@/components/TaskDetailsPanel";
import { AgentsPage } from "@/components/AgentsPage";
import { AgentEditPage } from "@/components/AgentEditPage";
import { WorkspaceChannelPage } from "@/components/WorkspaceChannelPage";
import {
  GlobalSettingsModal,
  TaskModal,
  WorkspaceModal
} from "@/components/WorkspaceModals";
import { WorkspaceSettingsPage } from "@/components/WorkspaceSettingsPage";
import { TopBar } from "@/components/TopBar";
import { useBoardData } from "@/hooks/useBoardData";
import { api } from "@/lib/api";
import { useWorkspaceSocket } from "@/hooks/useWorkspaceSocket";
import {
  resolveActiveRunId,
  resolveRunSelectionAfterStart,
  resolveViewedRunId
} from "@/lib/run-selection";
import { isBoardVisibleColumn, type DisplayTaskColumn } from "@/lib/task-view";
import { readStoredValue, writeStoredValue } from "@/lib/persist";
import { queryClient } from "@/lib/query";
import { applyTheme, getPreferredTheme, type ThemeMode } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { prepareLiveLogEntries } from "@/components/live-log-entries";
import { getTaskCoordinationScope } from "@/lib/coordination";
import { useAgents, workspaceAgentQueryKeys } from "@/hooks/useAgents";
import { workspaceChannelQueryKeys } from "@/hooks/useChannels";
import {
  coordinationQueryKeys,
  useCoordinationMessages,
  useCoordinationProposals,
  usePostCoordinationMessage
} from "@/hooks/useCoordination";
import {
  teamQueryKeys,
  useTeam
} from "@/hooks/useTeams";

export default function App() {
  return <ReactAppShell />;
}

const CHANNEL_UNREAD_COUNTS_STORAGE_KEY = "workhorse.channelUnreadCounts";

function workspaceBoardPath(workspaceId: string | "all"): string {
  return workspaceId === "all" ? "/" : `/workspaces/${workspaceId}/board`;
}

function workspaceChannelPath(workspaceId: string, channelSlug: string): string {
  return `/workspaces/${workspaceId}/channels/${channelSlug}`;
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
  const [channelUnreadCounts, setChannelUnreadCounts] = useState<Record<string, number>>(() =>
    readStoredValue<Record<string, number>>(CHANNEL_UNREAD_COUNTS_STORAGE_KEY, {})
  );
  const { displayedTasks, workspacesQuery } = board;
  const agentsQuery = useAgents();
  const activeChannelIdRef = useRef<string | null>(null);

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
          queryClient.invalidateQueries({ queryKey: workspaceChannelQueryKeys.lists() });
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
            queryKey: coordinationQueryKeys.messages({
              kind: "legacy_team",
              teamId: event.teamId,
              parentTaskId: event.parentTaskId
            })
          });
          break;
        case "team.task.created":
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          queryClient.invalidateQueries({
            queryKey: coordinationQueryKeys.messages({
              kind: "legacy_team",
              teamId: event.teamId,
              parentTaskId: event.parentTaskId
            })
          });
          break;
        case "team.proposal.created":
        case "team.proposal.updated":
          queryClient.invalidateQueries({
            queryKey: coordinationQueryKeys.proposals({
              kind: "legacy_team",
              teamId: event.teamId,
              parentTaskId: event.parentTaskId
            })
          });
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
        case "workspace.channel.updated":
          queryClient.invalidateQueries({
            queryKey: workspaceChannelQueryKeys.list(event.workspaceId)
          });
          break;
        case "task.message.created":
          queryClient.invalidateQueries({
            queryKey: coordinationQueryKeys.messages({
              kind: "workspace",
              workspaceId: event.workspaceId,
              parentTaskId: event.parentTaskId
            })
          });
          break;
        case "workspace.proposal.created":
        case "workspace.proposal.updated":
          queryClient.invalidateQueries({
            queryKey: coordinationQueryKeys.proposals({
              kind: "workspace",
              workspaceId: event.workspaceId,
              parentTaskId: event.parentTaskId
            })
          });
          break;
        case "channel.message.created":
          queryClient.invalidateQueries({
            queryKey: coordinationQueryKeys.messages({
              kind: "workspace_channel",
              workspaceId: event.workspaceId,
              channelId: event.channelId
            })
          });
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          if (
            event.message.senderType !== "human" &&
            event.channelId !== activeChannelIdRef.current
          ) {
            setChannelUnreadCounts((current) => ({
              ...current,
              [event.channelId]: (current[event.channelId] ?? 0) + 1
            }));
          }
          break;
        case "channel.proposal.created":
        case "channel.proposal.updated":
          queryClient.invalidateQueries({
            queryKey: coordinationQueryKeys.proposals({
              kind: "workspace_channel",
              workspaceId: event.workspaceId,
              channelId: event.channelId
            })
          });
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          queryClient.invalidateQueries({
            queryKey: workspaceChannelQueryKeys.list(event.workspaceId)
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
  const workspaceChannelQueries = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: workspaceChannelQueryKeys.list(workspace.id),
      queryFn: async () => (await api.listWorkspaceChannels(workspace.id)).items,
      enabled: workspaces.length > 0
    }))
  });
  const workspaceChannelsByWorkspaceId = useMemo(() => {
    const map = new Map<string, WorkspaceChannel[]>();
    for (const [index, workspace] of workspaces.entries()) {
      map.set(workspace.id, workspaceChannelQueries[index]?.data ?? []);
    }
    return map;
  }, [workspaceChannelQueries, workspaces]);
  const availableChannelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const channels of workspaceChannelsByWorkspaceId.values()) {
      for (const channel of channels) {
        ids.add(channel.id);
      }
    }
    return ids;
  }, [workspaceChannelsByWorkspaceId]);
  const taskChannelByTaskId = useMemo(() => {
    const map = new Map<string, WorkspaceChannel>();
    for (const channels of workspaceChannelsByWorkspaceId.values()) {
      for (const channel of channels) {
        if (channel.kind === "task" && channel.taskId && !channel.archivedAt) {
          map.set(channel.taskId, channel);
        }
      }
    }
    return map;
  }, [workspaceChannelsByWorkspaceId]);
  const routeWorkspaceMatch = matchPath("/workspaces/:workspaceId/*", location.pathname);
  const routeBoardMatch = matchPath("/workspaces/:workspaceId/board", location.pathname);
  const routeChannelMatch = matchPath(
    "/workspaces/:workspaceId/channels/:channelSlug",
    location.pathname
  );
  const routeSelectedWorkspaceId =
    routeWorkspaceMatch?.params.workspaceId ?? (location.pathname === "/" ? "all" : null);
  const activeWorkspaceId = routeSelectedWorkspaceId ?? board.selectedWorkspaceId;
  const routeChannelSlug = routeChannelMatch?.params.channelSlug ?? null;
  const routedChannel =
    routeSelectedWorkspaceId && routeSelectedWorkspaceId !== "all" && routeChannelSlug
      ? workspaceChannelsByWorkspaceId
          .get(routeSelectedWorkspaceId)
          ?.find(
            (channel) =>
              channel.slug === routeChannelSlug || channel.id === routeChannelSlug
          ) ?? null
      : null;
  const activeChannelId =
    routedChannel?.id ??
    (location.pathname === "/" || routeBoardMatch ? null : board.selectedChannelId);

  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

  useEffect(() => {
    writeStoredValue(CHANNEL_UNREAD_COUNTS_STORAGE_KEY, channelUnreadCounts);
  }, [channelUnreadCounts]);

  useEffect(() => {
    setChannelUnreadCounts((current) => {
      const nextEntries = Object.entries(current).filter(
        ([channelId, count]) => availableChannelIds.has(channelId) && count > 0
      );
      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }
      return Object.fromEntries(nextEntries);
    });
  }, [availableChannelIds]);

  useEffect(() => {
    if (!activeChannelId) {
      return;
    }

    setChannelUnreadCounts((current) => {
      if (!current[activeChannelId]) {
        return current;
      }

      const next = { ...current };
      delete next[activeChannelId];
      return next;
    });
  }, [activeChannelId]);

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
      const coordinationTag = task.teamId
        ? "legacy team"
        : task.parentTaskId ||
            (workspaceAgentsByWorkspaceId.get(task.workspaceId) ?? []).some(
              (agent) => agent.role === "coordinator"
            )
          ? "agents coordination"
          : "";
      return [task.title, task.description, workspaceName, coordinationTag, task.runnerType, task.column]
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

    if (activeChannelId !== board.selectedChannelId) {
      board.setChannelSelection(activeChannelId ?? null);
    }

    if (!routeChannelMatch) {
      return;
    }

    const nextChannel = routedChannel;

    if (nextChannel?.taskId && board.selectedTask?.id !== nextChannel.taskId) {
      board.setTaskSelection(nextChannel.taskId);
    }

    if (nextChannel && !nextChannel.taskId && board.selectedTask?.id) {
      board.setTaskSelection(null);
    }
  }, [
    activeChannelId,
    activeWorkspaceId,
    board.selectedChannelId,
    board.selectedTask?.id,
    board.selectedWorkspaceId,
    board.setChannelSelection,
    board.setTaskSelection,
    board.setWorkspaceSelection,
    routeChannelMatch,
    routedChannel,
    workspaceChannelsByWorkspaceId
  ]);

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
    const task = allTasks.find((entry) => entry.id === taskId) ?? null;
    const taskChannel = task ? taskChannelByTaskId.get(task.id) ?? null : null;

    board.setSidebarCollapsed(true);
    if (task && taskChannel) {
      board.setWorkspaceSelection(task.workspaceId);
      board.setChannelSelection(taskChannel.id);
      navigate(workspaceChannelPath(task.workspaceId, taskChannel.slug));
      return;
    }

    navigate(`/tasks/${taskId}`);
  }

  const boardPage = (
    <section className="min-h-0 overflow-hidden px-3 pb-3 pt-2.5 sm:px-4 sm:pb-4 lg:px-5 lg:pb-5 lg:pt-3.5">
      <DragDropContext onDragEnd={handleDrop}>
        <Board
          tasks={boardTasks}
          allTasks={allTasks}
          accountAgents={accountAgents}
          workspaceAgentsByWorkspaceId={workspaceAgentsByWorkspaceId}
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
          onApproveSubtask={(task) =>
            void board.approveTask({
              taskId: task.id,
              teamId: task.teamId,
              workspaceId: task.workspaceId,
              parentTaskId: task.parentTaskId
            })
          }
          onRejectSubtask={(task, reason) =>
            void board.rejectTask({
              taskId: task.id,
              teamId: task.teamId,
              workspaceId: task.workspaceId,
              parentTaskId: task.parentTaskId,
              reason
            })
          }
          onRetrySubtask={(task) =>
            void board.retryTask({
              taskId: task.id,
              teamId: task.teamId,
              workspaceId: task.workspaceId,
              parentTaskId: task.parentTaskId
            })
          }
          onCancelSubtask={(task) =>
            void board.cancelSubtask({
              taskId: task.id,
              teamId: task.teamId,
              workspaceId: task.workspaceId,
              parentTaskId: task.parentTaskId
            })
          }
          reviewActionBusy={board.isBusy}
        />
      </DragDropContext>
    </section>
  );

  const isTaskDetailView = location.pathname.startsWith("/tasks/");
  const isChannelView = location.pathname.includes("/channels/");
  const isAgentsView = location.pathname.startsWith("/agents");
  const isWorkspaceSettingsView = location.pathname === "/workspace-settings";

  return (
    <div
      className={`min-h-screen bg-background text-foreground lg:grid lg:h-screen lg:overflow-hidden ${board.sidebarCollapsed ? "lg:grid-cols-[72px_minmax(0,1fr)]" : "lg:grid-cols-[288px_minmax(0,1fr)]"}`}
    >
      <Sidebar
        workspaces={workspaces}
        allTasks={allTasks}
        workspaceChannelsByWorkspaceId={workspaceChannelsByWorkspaceId}
        channelUnreadCounts={channelUnreadCounts}
        agentCount={accountAgents.length}
        selectedWorkspaceId={activeWorkspaceId}
        selectedChannelId={activeChannelId}
        collapsed={board.sidebarCollapsed}
        onToggleCollapse={board.toggleSidebarCollapsed}
        onSelectWorkspace={(workspaceId) => {
          board.setWorkspaceSelection(workspaceId);
          board.setChannelSelection(null);
          navigate(workspaceBoardPath(workspaceId));
        }}
        onSelectChannel={(workspaceId, channelId) => {
          board.setWorkspaceSelection(workspaceId);
          board.setChannelSelection(channelId);
          const channel =
            workspaceChannelsByWorkspaceId
              .get(workspaceId)
              ?.find((entry) => entry.id === channelId) ?? null;
          if (channel?.taskId) {
            board.setTaskSelection(channel.taskId);
          }
          navigate(workspaceChannelPath(workspaceId, channel?.slug ?? channelId));
        }}
        onAddWorkspace={() => board.setWorkspaceModalOpen(true)}
        onOpenAgents={() => navigate("/agents")}
        onOpenWorkspaceSettings={() => navigate("/workspace-settings")}
        onOpenGlobalSettings={() => board.setGlobalSettingsModalOpen(true)}
      />

      <main
        className={
          isTaskDetailView || isChannelView
            ? "relative z-[1] min-h-screen min-w-0 overflow-hidden lg:min-h-0"
            : "relative z-[1] grid min-h-screen min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden lg:min-h-0"
        }
      >
        {isTaskDetailView || isChannelView || isAgentsView || isWorkspaceSettingsView ? null : (
          <TopBar
            onCreateTask={() => board.setTaskModalOpen(true)}
            onRefresh={() => {
              void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
              void queryClient.invalidateQueries({ queryKey: ["tasks"] });
              void queryClient.invalidateQueries({
                queryKey: workspaceChannelQueryKeys.lists()
              });
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
          />
        )}

        <Routes>
          <Route path="/" element={boardPage} />
          <Route
            path="/workspaces/:workspaceId/board"
            element={boardPage}
          />
          <Route
            path="/workspaces/:workspaceId/channels/:channelSlug"
            element={
              <WorkspaceChannelRoute
                board={board}
                allTasks={allTasks}
                workspaces={workspaces}
                workspaceAgentsByWorkspaceId={workspaceAgentsByWorkspaceId}
                workspaceChannelsByWorkspaceId={workspaceChannelsByWorkspaceId}
              />
            }
          />
          <Route
            path="/tasks/:taskId"
            element={
              <TaskDetailsRoute
                board={board}
                allTasks={allTasks}
                workspaces={workspaces}
                workspaceAgentsByWorkspaceId={workspaceAgentsByWorkspaceId}
                taskChannelByTaskId={taskChannelByTaskId}
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
  taskChannelByTaskId: Map<string, WorkspaceChannel>;
}

function TaskDetailsRoute({
  board,
  allTasks,
  workspaces,
  workspaceAgentsByWorkspaceId,
  taskChannelByTaskId
}: TaskDetailsRouteProps) {
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();

  useEffect(() => {
    if (taskId && board.selectedTask?.id !== taskId) {
      board.setTaskSelection(taskId);
    }
  }, [board.selectedTask?.id, board.setTaskSelection, taskId]);

  const task = taskId ? allTasks.find((entry) => entry.id === taskId) ?? null : null;
  const taskChannel = task ? taskChannelByTaskId.get(task.id) ?? null : null;
  const workspaceAgents = task
    ? workspaceAgentsByWorkspaceId.get(task.workspaceId) ?? []
    : [];
  const coordinationScope = getTaskCoordinationScope(task, workspaceAgents);
  const proposalScope =
    task && !task.parentTaskId ? coordinationScope : ({ kind: "none" } as const);
  const legacyTeam = useTeam(
    coordinationScope.kind === "legacy_team" ? coordinationScope.teamId : null
  );
  const coordinationMessages = useCoordinationMessages(coordinationScope);
  const postCoordinationMessage = usePostCoordinationMessage(coordinationScope);
  const coordinationProposals = useCoordinationProposals(proposalScope);
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

  if (taskChannel) {
    return (
      <Navigate
        to={workspaceChannelPath(task.workspaceId, taskChannel.slug)}
        replace
      />
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
        legacyTeam={legacyTeam.data ?? null}
        workspaceAgents={workspaceAgents}
        coordinationScope={coordinationScope}
        coordinationMessages={coordinationMessages.data ?? []}
        coordinationMessagesLoading={coordinationMessages.isLoading}
        coordinationMessagesError={
          coordinationMessages.error instanceof Error ? coordinationMessages.error.message : null
        }
        coordinationProposals={coordinationProposals.data ?? []}
        coordinationProposalsLoading={coordinationProposals.isLoading}
        selectedRunId={board.selectedRunId}
        runLogLoading={runLogQuery.isLoading}
        onBack={() => navigate("/")}
        onSelectRun={board.setSelectedRunId}
        liveLog={liveLog}
        runLog={runLog}
        onPlan={() => board.planTask(task.id)}
        onSendPlanFeedback={(text) => board.sendPlanFeedback({ taskId: task.id, text })}
        onSendCoordinationMessage={
          coordinationScope.kind !== "none"
            ? (text) => postCoordinationMessage.mutateAsync(text)
            : undefined
        }
        onApproveSubtask={
          task.parentTaskId && coordinationScope.kind !== "none"
            ? () =>
                board.approveTask({
                  taskId: task.id,
                  teamId: task.teamId,
                  workspaceId: task.workspaceId,
                  parentTaskId: task.parentTaskId
                })
            : undefined
        }
        onRejectSubtask={
          task.parentTaskId && coordinationScope.kind !== "none"
            ? (reason) =>
                board.rejectTask({
                  taskId: task.id,
                  teamId: task.teamId,
                  workspaceId: task.workspaceId,
                  parentTaskId: task.parentTaskId,
                  reason
                })
            : undefined
        }
        onRetrySubtask={
          task.parentTaskId && coordinationScope.kind !== "none"
            ? () =>
                board.retryTask({
                  taskId: task.id,
                  teamId: task.teamId,
                  workspaceId: task.workspaceId,
                  parentTaskId: task.parentTaskId
                })
            : undefined
        }
        onCancelSubtask={
          task.parentTaskId && coordinationScope.kind !== "none"
            ? () =>
                board.cancelSubtask({
                  taskId: task.id,
                  teamId: task.teamId,
                  workspaceId: task.workspaceId,
                  parentTaskId: task.parentTaskId
                })
            : undefined
        }
        reviewActionBusy={board.isBusy}
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

interface WorkspaceChannelRouteProps {
  board: BoardData;
  allTasks: BoardData["displayedTasks"];
  workspaces: Workspace[];
  workspaceAgentsByWorkspaceId: Map<string, WorkspaceAgent[]>;
  workspaceChannelsByWorkspaceId: Map<string, WorkspaceChannel[]>;
}

function WorkspaceChannelRoute({
  board,
  allTasks,
  workspaces,
  workspaceAgentsByWorkspaceId,
  workspaceChannelsByWorkspaceId
}: WorkspaceChannelRouteProps) {
  const navigate = useNavigate();
  const { workspaceId, channelSlug } = useParams<{
    workspaceId: string;
    channelSlug: string;
  }>();
  const resolvedWorkspaceId = workspaceId ?? "";
  const resolvedChannelSlug = channelSlug ?? "";

  const workspace = workspaces.find((entry) => entry.id === resolvedWorkspaceId) ?? null;
  const listedChannel =
    workspaceChannelsByWorkspaceId
      .get(resolvedWorkspaceId)
      ?.find(
        (entry) =>
          entry.slug === resolvedChannelSlug || entry.id === resolvedChannelSlug
      ) ?? null;
  const channelQuery = useQuery({
    queryKey: ["workspace-channel", resolvedWorkspaceId, resolvedChannelSlug],
    queryFn: async () => {
      if (!resolvedWorkspaceId || !resolvedChannelSlug) {
        return null;
      }
      try {
        return (
          await api.getWorkspaceChannelBySlug(
            resolvedWorkspaceId,
            resolvedChannelSlug
          )
        ).channel;
      } catch {
        return (await api.getWorkspaceChannel(resolvedWorkspaceId, resolvedChannelSlug))
          .channel;
      }
    },
    enabled: Boolean(resolvedWorkspaceId && resolvedChannelSlug && !listedChannel)
  });
  const channel = listedChannel ?? channelQuery.data ?? null;
  const listedTask = channel?.taskId
    ? allTasks.find((entry) => entry.id === channel.taskId) ?? null
    : null;
  const hiddenTaskQuery = useQuery({
    queryKey: ["task-hidden", channel?.taskId ?? ""],
    queryFn: async (): Promise<Task | null> => {
      if (!channel?.taskId) {
        return null;
      }

      return (await api.getTask(channel.taskId)).task;
    },
    enabled: Boolean(channel?.taskId && !listedTask)
  });
  const task = listedTask ?? hiddenTaskQuery.data ?? null;
  const workspaceAgents = workspaceAgentsByWorkspaceId.get(resolvedWorkspaceId) ?? [];
  const scope =
    channel !== null && resolvedWorkspaceId
      ? ({ kind: "workspace_channel", workspaceId: resolvedWorkspaceId, channelId: channel.id } as const)
      : ({ kind: "none" } as const);
  const messages = useCoordinationMessages(scope);
  const postMessage = usePostCoordinationMessage(scope);
  const proposals = useCoordinationProposals(scope);
  const taskRunsQuery = useQuery({
    queryKey: ["runs", task?.id ?? ""],
    queryFn: async () => {
      if (!task?.id) {
        return [];
      }
      const response = await api.listRuns(task.id);
      return response.items;
    },
    enabled: Boolean(task?.id)
  });
  const runs = taskRunsQuery.data ?? [];
  const activeRunId = useMemo(() => resolveActiveRunId(runs), [runs]);
  const viewedRunId = useMemo(
    () =>
      resolveViewedRunId({
        runs,
        selectedRunId: board.selectedRunId,
        lastRunId: task?.lastRunId
      }),
    [board.selectedRunId, runs, task?.lastRunId]
  );
  const liveLog =
    activeRunId && viewedRunId === activeRunId ? board.liveLogByRunId[activeRunId] ?? [] : [];
  const activeRunLiveLog = activeRunId ? board.liveLogByRunId[activeRunId] ?? [] : [];
  const runLogQuery = useQuery({
    queryKey: ["run-log", viewedRunId ?? ""],
    queryFn: async (): Promise<RunLogEntry[]> => {
      if (!viewedRunId) {
        return [];
      }

      return (await api.getRunLog(viewedRunId)).items;
    },
    enabled: Boolean(viewedRunId)
  });

  if (!workspaceId || !channelSlug) {
    return <Navigate to="/" replace />;
  }

  if (!channel) {
    return (
      <section className="flex h-full min-h-0 w-full">
        <TaskRouteState
          eyebrow="Workspace channel"
          title={channelQuery.isLoading ? "Loading channel" : "Channel not found"}
          description={
            channelQuery.isLoading || hiddenTaskQuery.isLoading
              ? "We are loading the latest channel state for this workspace."
              : "This channel may have been archived, or the workspace channel list has not loaded yet."
          }
          actionLabel="Back to board"
          onAction={() => navigate(workspaceBoardPath(resolvedWorkspaceId))}
        />
      </section>
    );
  }

  if (resolvedChannelSlug !== channel.slug) {
    return (
      <Navigate
        to={workspaceChannelPath(resolvedWorkspaceId, channel.slug)}
        replace
      />
    );
  }

  return (
    <WorkspaceChannelPage
      workspace={workspace}
      channel={channel}
      task={task}
      workspaceAgents={workspaceAgents}
      scope={scope}
      messages={messages.data ?? []}
      messagesLoading={messages.isLoading}
      messagesError={messages.error instanceof Error ? messages.error.message : null}
      proposals={channel.kind === "all" ? proposals.data ?? [] : []}
      proposalsLoading={channel.kind === "all" ? proposals.isLoading : false}
      onSendMessage={
        scope.kind !== "none"
          ? (text) => postMessage.mutateAsync(text)
          : undefined
      }
      runs={runs}
      selectedRunId={board.selectedRunId}
      runLogLoading={runLogQuery.isLoading}
      onSelectRun={board.setSelectedRunId}
      liveLog={liveLog}
      activeRunLiveLog={activeRunLiveLog}
      runLog={runLogQuery.data ?? []}
      onBackToBoard={() => navigate(workspaceBoardPath(resolvedWorkspaceId))}
      onPlan={task ? () => void board.planTask(task.id) : undefined}
      onStart={task ? () => void board.startTask(task.id) : undefined}
      onRequestReview={task ? () => void board.requestTaskReview(task.id) : undefined}
      onStop={task ? () => void board.stopTask(task.id) : undefined}
      onMoveToTodo={task ? () => void board.moveToTodo(task.id) : undefined}
      onMarkDone={task ? () => void board.markDone(task.id) : undefined}
      onArchive={task ? () => void board.archiveTask(task.id) : undefined}
      onCleanupWorktree={task ? () => void board.cleanupTaskWorktree(task.id) : undefined}
      onDelete={
        task
          ? () => {
              void board.deleteTask(task.id).then(() => {
                navigate(workspaceBoardPath(resolvedWorkspaceId));
              });
            }
          : undefined
      }
      onApproveSubtask={
        task?.parentTaskId
          ? () =>
              void board.approveTask({
                taskId: task.id,
                teamId: task.teamId,
                workspaceId: task.workspaceId,
                parentTaskId: task.parentTaskId
              })
          : undefined
      }
      onRejectSubtask={
        task?.parentTaskId
          ? () => {
              const reason = window.prompt(
                `Why reject "${task.title}"? (optional)`,
                ""
              );
              if (reason === null) {
                return;
              }
              void board.rejectTask({
                taskId: task.id,
                teamId: task.teamId,
                workspaceId: task.workspaceId,
                parentTaskId: task.parentTaskId,
                reason: reason || undefined
              });
            }
          : undefined
      }
      onRetrySubtask={
        task?.parentTaskId
          ? () =>
              void board.retryTask({
                taskId: task.id,
                teamId: task.teamId,
                workspaceId: task.workspaceId,
                parentTaskId: task.parentTaskId
              })
          : undefined
      }
      onCancelSubtask={
        task?.parentTaskId
          ? () => {
              if (!window.confirm(`Cancel subtask "${task.title}"?`)) {
                return;
              }
              void board.cancelSubtask({
                taskId: task.id,
                teamId: task.teamId,
                workspaceId: task.workspaceId,
                parentTaskId: task.parentTaskId
              });
            }
          : undefined
      }
      reviewActionBusy={board.isBusy}
    />
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
