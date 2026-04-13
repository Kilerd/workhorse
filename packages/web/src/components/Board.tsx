import { useEffect, useMemo, useState } from "react";
import { Draggable, Droppable } from "@hello-pangea/dnd";
import type { AgentTeam, Workspace } from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import { BOARD_COLUMNS, type DisplayTask, type DisplayTaskColumn } from "@/lib/task-view";
import { cn } from "@/lib/utils";
import { CompactPullRequestStatus } from "./CompactPullRequestStatus";
import { SubtaskReviewActions } from "./SubtaskReviewActions";
import { TaskActionBar } from "./TaskActionBar";

interface ReviewMonitor {
  intervalMs: number;
  lastPolledAt?: string;
}

interface ReviewCountdown {
  label: string;
  progress: number;
}

interface Props {
  tasks: DisplayTask[];
  allTasks: DisplayTask[];
  teams: AgentTeam[];
  workspaces: Workspace[];
  reviewMonitor: ReviewMonitor;
  selectedTaskId: string | null;
  onTaskOpen(taskId: string): void;
  onPlan(taskId: string): void;
  onTaskStart(taskId: string): void;
  onTaskStop(taskId: string): void;
  onMoveToTodo(taskId: string): void;
  onMarkDone(taskId: string): void;
  onArchive(taskId: string): void;
  onApproveSubtask(taskId: string, teamId: string, parentTaskId: string): void;
  onRejectSubtask(taskId: string, teamId: string, parentTaskId: string, reason?: string): void;
  onRetrySubtask(taskId: string, teamId: string, parentTaskId: string): void;
  onCancelSubtask(taskId: string, teamId: string, parentTaskId: string): void;
  reviewActionBusy?: boolean;
}

const boardClass =
  "grid h-full min-h-0 auto-cols-[minmax(220px,1fr)] grid-flow-col overflow-x-auto overflow-y-hidden bg-[var(--panel)] max-[720px]:auto-cols-[minmax(180px,88vw)]";
const columnClass =
  "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-r border-border bg-transparent last:border-r-0";
const columnHeaderClass =
  "flex min-h-9 items-center justify-between gap-3 border-b border-border bg-[var(--surface-soft)] px-3 py-2";
const columnListClass =
  "grid min-h-0 content-start gap-2 overflow-x-hidden overflow-y-auto overscroll-contain p-2";
const taskCardClass =
  "grid gap-0 rounded-none border bg-[var(--panel)] p-4 text-left transition-[border-color,transform,background-color] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] focus:outline-none";
function groupTasks(): Record<DisplayTaskColumn, DisplayTask[]> {
  return {
    backlog: [],
    todo: [],
    blocked: [],
    running: [],
    review: [],
    done: [],
    archived: []
  };
}

function formatReviewCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) {
    return `${seconds}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function getReviewCountdown(reviewMonitor: ReviewMonitor, nowMs: number): ReviewCountdown | null {
  if (reviewMonitor.intervalMs <= 0 || !reviewMonitor.lastPolledAt) {
    return null;
  }

  const lastPolledAtMs = Date.parse(reviewMonitor.lastPolledAt);
  if (Number.isNaN(lastPolledAtMs)) {
    return null;
  }

  const elapsedMs = Math.max(nowMs - lastPolledAtMs, 0);
  const remainingMs = Math.max(reviewMonitor.intervalMs - elapsedMs, 0);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const label = formatReviewCountdown(remainingSeconds);

  return {
    label,
    progress: Math.min(elapsedMs / reviewMonitor.intervalMs, 1)
  };
}

function getTaskRunBadge(task: DisplayTask) {
  if (task.cancelledAt) {
    return {
      label: "CANCELLED",
      className:
        "border-[rgba(242,195,92,0.28)] bg-[rgba(242,195,92,0.12)] text-[var(--warning)]"
    };
  }

  if (task.rejected) {
    return {
      label: "REJECTED",
      className: "border-[rgba(240,113,113,0.28)] bg-[rgba(240,113,113,0.12)] text-[var(--danger)]"
    };
  }

  if (task.column === "running") {
    return {
      label: "RUNNING",
      className: "border-[rgba(242,195,92,0.24)] bg-[rgba(242,195,92,0.1)] text-[var(--warning)]"
    };
  }

  if (task.column === "review") {
    return {
      label: "COMPLETED",
      className: "border-[rgba(99,216,158,0.26)] bg-[rgba(99,216,158,0.1)] text-[var(--success)]"
    };
  }

  if (task.column === "todo") {
    if (task.plan) {
      return {
        label: "PLANNED",
        className: "border-[rgba(73,214,196,0.24)] bg-[rgba(73,214,196,0.1)] text-[var(--accent-strong)]"
      };
    }
    return {
      label: "TODO",
      className: "border-[rgba(104,199,246,0.24)] bg-[rgba(104,199,246,0.1)] text-[var(--info)]"
    };
  }

  if (task.column === "blocked") {
    return {
      label: "BLOCKED",
      className: "border-[rgba(192,132,252,0.28)] bg-[rgba(192,132,252,0.1)] text-[var(--accent)]"
    };
  }

  if (task.column === "done") {
    return {
      label: "DONE",
      className: "border-[rgba(99,216,158,0.26)] bg-[rgba(99,216,158,0.1)] text-[var(--success)]"
    };
  }

  if (task.column === "backlog") {
    if (task.lastRunId) {
      return {
        label: "PLANNING",
        className: "border-[rgba(242,195,92,0.24)] bg-[rgba(242,195,92,0.1)] text-[var(--warning)]"
      };
    }
    return {
      label: "BACKLOG",
      className: "border-[rgba(128,146,152,0.24)] bg-[rgba(128,146,152,0.08)] text-[var(--muted)]"
    };
  }

  return {
    label: titleCase(task.column),
    className: "text-[var(--muted)]"
  };
}

function shouldShowColumnBadge(column: DisplayTaskColumn, task?: DisplayTask) {
  if (column === "backlog") {
    return Boolean(task?.lastRunId);
  }
  return true;
}

function getBlockedByEntries(
  task: DisplayTask,
  allTasks: DisplayTask[]
): { id: string; title: string }[] {
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  return task.dependencies
    .map((depId) => {
      const dep = taskMap.get(depId);
      if (!dep || dep.column === "done") return null;
      return { id: depId, title: dep.title };
    })
    .filter((entry): entry is { id: string; title: string } => entry !== null);
}

function getTaskCardToneClass(column: DisplayTaskColumn) {
  switch (column) {
    case "backlog":
      return "border-[rgba(128,146,152,0.28)]";
    case "todo":
      return "border-[rgba(104,199,246,0.28)]";
    case "blocked":
      return "border-[rgba(192,132,252,0.3)]";
    case "running":
      return "border-[rgba(242,195,92,0.32)]";
    case "review":
      return "border-[rgba(73,214,196,0.34)]";
    case "done":
      return "border-[rgba(99,216,158,0.3)]";
    case "archived":
      return "border-[rgba(164,145,145,0.28)]";
  }
}

function shouldShowCardActions(column: DisplayTaskColumn, isActive: boolean) {
  if (column === "backlog" || column === "todo") {
    return true;
  }

  if (column === "done") {
    return isActive;
  }

  return false;
}

function shouldShowBlockedBy(column: DisplayTaskColumn) {
  return column === "blocked";
}

function resolveTeamAgentName(team: AgentTeam | null, teamAgentId?: string) {
  if (!team || !teamAgentId) {
    return null;
  }
  return team.agents.find((agent) => agent.id === teamAgentId)?.agentName ?? null;
}

export function Board({
  tasks,
  allTasks,
  teams,
  workspaces,
  reviewMonitor,
  selectedTaskId,
  onTaskOpen,
  onPlan,
  onTaskStart,
  onTaskStop,
  onMoveToTodo,
  onMarkDone,
  onArchive,
  onApproveSubtask,
  onRejectSubtask,
  onRetrySubtask,
  onCancelSubtask,
  reviewActionBusy = false
}: Props) {
  const grouped = BOARD_COLUMNS.reduce((acc, column) => {
    acc[column.id] = tasks
      .filter((task) => task.column === column.id)
      .sort((left, right) => left.order - right.order);
    return acc;
  }, groupTasks());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const teamMap = useMemo(
    () => new Map<string, AgentTeam>(teams.map((team) => [team.id, team])),
    [teams]
  );
  const childTaskMap = useMemo(() => {
    const map = new Map<string, DisplayTask[]>();
    for (const task of allTasks) {
      if (!task.parentTaskId) {
        continue;
      }
      const siblings = map.get(task.parentTaskId);
      if (siblings) {
        siblings.push(task);
      } else {
        map.set(task.parentTaskId, [task]);
      }
    }
    for (const siblings of map.values()) {
      siblings.sort((left, right) => left.order - right.order);
    }
    return map;
  }, [allTasks]);
  const showReviewMonitor = tasks.some(
    (task) => task.column === "review" && Boolean(task.pullRequestUrl)
  );

  useEffect(() => {
    if (!showReviewMonitor || reviewMonitor.intervalMs <= 0 || !reviewMonitor.lastPolledAt) {
      return;
    }

    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [reviewMonitor.intervalMs, reviewMonitor.lastPolledAt, showReviewMonitor]);

  return (
    <section className={boardClass}>
      {BOARD_COLUMNS.map((column) => (
        <Droppable droppableId={column.id} key={column.id}>
          {(provided, snapshot) => (
            <article
              className={cn(columnClass, snapshot.isDraggingOver && "bg-[rgba(73,214,196,0.05)]")}
            >
              <div className={columnHeaderClass}>
                <h2 className="m-0 text-[0.875rem] font-semibold">{column.title}</h2>
                <span className="text-[0.7rem] text-[var(--muted)]">
                  {grouped[column.id]!.length} cards
                </span>
              </div>

              <div
                className={columnListClass}
                ref={provided.innerRef}
                {...provided.droppableProps}
              >
                {grouped[column.id]!.map((task, index) => {
                  const isActive = task.id === selectedTaskId;
                  const workspace = workspaces.find((entry) => entry.id === task.workspaceId);
                  const workspaceName = workspace?.name ?? "Unknown";
                  const team = task.teamId ? teamMap.get(task.teamId) ?? null : null;
                  const teamAgentName = resolveTeamAgentName(team, task.teamAgentId);
                  const childTasks =
                    task.teamId && !task.parentTaskId
                      ? childTaskMap.get(task.id) ?? []
                      : [];
                  const reviewCountdown =
                    task.column === "review" && task.pullRequestUrl
                      ? getReviewCountdown(reviewMonitor, nowMs)
                      : null;
                  const taskRunBadge = getTaskRunBadge(task);
                  const showColumnBadge = shouldShowColumnBadge(task.column, task);
                  const showCardActions = shouldShowCardActions(task.column, isActive);
                  const showBlockedBy = shouldShowBlockedBy(task.column);
                  const blockedByEntries = showBlockedBy
                    ? getBlockedByEntries(task, allTasks)
                    : [];

                  return (
                    <Draggable draggableId={task.id} index={index} key={task.id}>
                      {(dragProvided, dragSnapshot) => (
                        <article
                          className={cn(
                            taskCardClass,
                            getTaskCardToneClass(task.column),
                            isActive && "border-[var(--border-strong)]",
                            dragSnapshot.isDragging && "rotate-1"
                          )}
                          ref={dragProvided.innerRef}
                          {...dragProvided.draggableProps}
                          {...dragProvided.dragHandleProps}
                          role="button"
                          tabIndex={0}
                          onClick={() => onTaskOpen(task.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onTaskOpen(task.id);
                            }
                          }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="m-0 min-w-0 overflow-hidden text-[0.84rem] font-semibold leading-[1.4] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                              {task.title}
                            </h3>
                          </div>

                          {task.description ? (
                            <p className="mt-2 m-0 overflow-hidden text-[0.7rem] leading-[1.55] text-[var(--muted)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                              {task.description}
                            </p>
                          ) : null}

                          {team ? (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <span className="inline-flex min-h-5 items-center rounded-none border border-[rgba(73,214,196,0.26)] bg-[rgba(73,214,196,0.1)] px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.1em] text-[var(--accent-strong)]">
                                Team · {team.agents.length} agents
                              </span>
                              {task.parentTaskId ? (
                                <span className="inline-flex min-h-5 items-center rounded-none border border-[rgba(104,199,246,0.24)] bg-[rgba(104,199,246,0.1)] px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.1em] text-[var(--info)]">
                                  Subtask{teamAgentName ? ` · ${teamAgentName}` : ""}
                                </span>
                              ) : null}
                            </div>
                          ) : null}

                          {!task.parentTaskId && childTasks.length > 0 ? (
                            <div className="mt-3 grid gap-2 border-t border-border pt-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                                  Team subtasks
                                </span>
                                <span className="text-[0.68rem] text-[var(--muted)]">
                                  {childTasks.length} total
                                </span>
                              </div>
                              {(isActive ? childTasks : childTasks.slice(0, 3)).map((childTask) => {
                                const childAgentName = resolveTeamAgentName(team, childTask.teamAgentId);
                                const isReviewSubtask = childTask.column === "review";
                                const isCancelableSubtask =
                                  Boolean(childTask.teamId && childTask.parentTaskId) &&
                                  !childTask.cancelledAt &&
                                  childTask.column !== "done" &&
                                  childTask.column !== "archived";
                                const canApprove =
                                  isReviewSubtask && childTask.lastRunStatus === "succeeded";
                                return (
                                  <article
                                    key={childTask.id}
                                    className="grid gap-2 rounded-none border border-border bg-[var(--surface-soft)] px-2.5 py-2"
                                  >
                                    <button
                                      type="button"
                                      className="grid gap-1 text-left transition-colors hover:text-foreground"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        onTaskOpen(childTask.id);
                                      }}
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="text-[0.72rem] font-medium leading-[1.35]">
                                          {childTask.title}
                                        </span>
                                        <span className="font-mono text-[0.58rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                                          {childTask.cancelledAt
                                            ? "Cancelled"
                                            : childTask.rejected
                                              ? "Rejected"
                                              : titleCase(childTask.column)}
                                        </span>
                                      </div>
                                      <span className="text-[0.66rem] text-[var(--muted)]">
                                        {childAgentName ?? "Unassigned agent"}
                                      </span>
                                    </button>
                                    {childTask.teamId &&
                                    childTask.parentTaskId &&
                                    (isReviewSubtask || isCancelableSubtask) ? (
                                      <SubtaskReviewActions
                                        compact
                                        disabled={reviewActionBusy}
                                        canApprove={canApprove}
                                        showApprove={isReviewSubtask}
                                        showReject={isReviewSubtask}
                                        showRetry={isReviewSubtask}
                                        showCancel={isCancelableSubtask}
                                        onApprove={() =>
                                          onApproveSubtask(
                                            childTask.id,
                                            childTask.teamId!,
                                            childTask.parentTaskId!
                                          )
                                        }
                                        onReject={() =>
                                          (() => {
                                            const reason = window.prompt(
                                              `Why reject "${childTask.title}"? (optional)`,
                                              ""
                                            );
                                            if (reason === null) {
                                              return;
                                            }
                                            onRejectSubtask(
                                              childTask.id,
                                              childTask.teamId!,
                                              childTask.parentTaskId!,
                                              reason || undefined
                                            );
                                          })()
                                        }
                                        onRetry={() =>
                                          onRetrySubtask(
                                            childTask.id,
                                            childTask.teamId!,
                                            childTask.parentTaskId!
                                          )
                                        }
                                        onCancel={() => {
                                          if (
                                            !window.confirm(
                                              `Cancel subtask "${childTask.title}"?`
                                            )
                                          ) {
                                            return;
                                          }
                                          onCancelSubtask(
                                            childTask.id,
                                            childTask.teamId!,
                                            childTask.parentTaskId!
                                          );
                                        }}
                                      />
                                    ) : null}
                                  </article>
                                );
                              })}
                              {!isActive && childTasks.length > 3 ? (
                                <span className="text-[0.68rem] text-[var(--muted)]">
                                  +{childTasks.length - 3} more subtasks
                                </span>
                              ) : null}
                            </div>
                          ) : null}

                          {showBlockedBy && blockedByEntries.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {blockedByEntries.map(({ id, title }) => (
                                <span
                                  key={id}
                                  className="inline-flex items-center rounded-none border border-[rgba(192,132,252,0.28)] bg-[rgba(192,132,252,0.1)] px-1.5 py-0.5 font-mono text-[0.58rem] text-[var(--accent)]"
                                >
                                  blocked by: {title}
                                </span>
                              ))}
                            </div>
                          ) : null}

                          {task.pullRequestUrl && task.pullRequest ? (
                            <div className="mt-3 border-t border-border pt-3">
                              <CompactPullRequestStatus
                                task={task}
                                reviewCountdown={reviewCountdown}
                              />
                            </div>
                          ) : null}

                          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[0.625rem]">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="min-w-0 truncate text-[0.66rem] leading-[1.3] text-[var(--muted)]">
                                {workspaceName}
                              </span>
                              {showColumnBadge ? (
                                <span
                                  className={cn(
                                    "inline-flex min-h-[18px] items-center whitespace-nowrap rounded-none border px-1.5 font-mono text-[0.6rem] uppercase tracking-[0.08em]",
                                    taskRunBadge.className
                                  )}
                                >
                                  {taskRunBadge.label}
                                </span>
                              ) : null}
                            </div>

                            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
                              <span className="whitespace-nowrap text-[0.68rem] leading-[1.3] text-[var(--muted)]">
                                {formatRelativeTime(task.updatedAt)}
                              </span>
                              {showCardActions ? (
                                <TaskActionBar
                                  column={task.column}
                                  task={task}
                                  compact
                                  onPlan={() => onPlan(task.id)}
                                  onStart={() => onTaskStart(task.id)}
                                  onStop={() => onTaskStop(task.id)}
                                  onMoveToTodo={() => onMoveToTodo(task.id)}
                                  onMarkDone={() => onMarkDone(task.id)}
                                  onArchive={() => onArchive(task.id)}
                                />
                              ) : null}
                            </div>
                          </div>
                        </article>
                      )}
                    </Draggable>
                  );
                })}
                {provided.placeholder}
              </div>
            </article>
          )}
        </Droppable>
      ))}
    </section>
  );
}
