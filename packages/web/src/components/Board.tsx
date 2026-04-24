import { useEffect, useMemo, useState } from "react";
import { Draggable, Droppable } from "@hello-pangea/dnd";
import type { Workspace, WorkspaceAgent } from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import { hasWorkspaceCoordinator, resolveWorkspaceAgentName } from "@/lib/coordination";
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
  workspaceAgentsByWorkspaceId: Map<string, WorkspaceAgent[]>;
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
  onApproveSubtask(task: DisplayTask): void;
  onRejectSubtask(task: DisplayTask, reason?: string): void;
  onRetrySubtask(task: DisplayTask): void;
  onCancelSubtask(task: DisplayTask): void;
  reviewActionBusy?: boolean;
}

const boardClass =
  "grid h-full min-h-0 auto-cols-[minmax(300px,1fr)] grid-flow-col gap-3 overflow-x-auto overflow-y-hidden bg-transparent pb-1 pr-2 max-[820px]:auto-cols-[minmax(280px,90vw)]";
const columnClass =
  "surface-card-faint grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden";
const columnHeaderClass =
  "flex min-h-0 items-center justify-between gap-3 border-b border-border px-3.5 py-2.5";
const columnListClass =
  "grid min-h-0 content-start gap-2.5 overflow-x-hidden overflow-y-auto overscroll-contain p-3";
const taskCardClass =
  "grid gap-0 rounded-[12px] border bg-[var(--surface-faint)] p-3.5 text-left transition-[border-color,transform,background-color] hover:-translate-y-px hover:bg-[var(--surface-hover)] focus:outline-none";
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
      className: "tone-warning"
    };
  }

  if (task.rejected) {
    return {
      label: "REJECTED",
      className: "tone-danger"
    };
  }

  if (task.column === "running") {
    return {
      label: "RUNNING",
      className: "tone-accent"
    };
  }

  if (task.column === "review") {
    return {
      label: "COMPLETED",
      className: "tone-success"
    };
  }

  if (task.column === "todo") {
    if (task.plan) {
      return {
        label: "PLANNED",
        className: "tone-accent"
      };
    }
    return {
      label: "TODO",
      className: "tone-info"
    };
  }

  if (task.column === "blocked") {
    return {
      label: "BLOCKED",
      className: "tone-warning"
    };
  }

  if (task.column === "done") {
    return {
      label: "DONE",
      className: "tone-success"
    };
  }

  if (task.column === "backlog") {
    if (task.lastRunId) {
      return {
        label: "PLANNING",
        className: "tone-warning"
      };
    }
    return {
      label: "BACKLOG",
      className: "tone-muted"
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
      return "border-border";
    case "todo":
      return "border-[rgba(122,127,173,0.24)]";
    case "blocked":
      return "border-[rgba(214,164,73,0.28)]";
    case "running":
      return "border-[rgba(113,112,255,0.34)]";
    case "review":
      return "border-[rgba(39,166,68,0.3)]";
    case "done":
      return "border-[rgba(39,166,68,0.22)]";
    case "archived":
      return "border-border";
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

export function Board({
  tasks,
  allTasks,
  workspaceAgentsByWorkspaceId,
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
              className={cn(
                columnClass,
                snapshot.isDraggingOver &&
                  "border-[var(--border-strong)] bg-[var(--surface-soft)]"
              )}
            >
              <div className={columnHeaderClass}>
                <h2 className="m-0 flex items-baseline gap-2 text-[0.92rem] font-[590] tracking-[-0.02em]">
                  <span className="text-[1.18rem] tabular-nums leading-none text-[var(--muted)]">
                    {grouped[column.id]!.length}
                  </span>
                  {column.title}
                </h2>
                <span className="section-kicker m-0">{column.id}</span>
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
                  const workspaceAgents =
                    workspaceAgentsByWorkspaceId.get(task.workspaceId) ?? [];
                  const hasCoordination =
                    Boolean(task.parentTaskId) || hasWorkspaceCoordinator(workspaceAgents);
                  const assignedAgentName = resolveWorkspaceAgentName(task, workspaceAgents);
                  const childTasks =
                    hasCoordination && !task.parentTaskId
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
                            isActive && "border-[rgba(255,255,255,0.16)]",
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
                            <h3 className="m-0 min-w-0 overflow-hidden text-[0.95rem] font-[590] leading-[1.3] tracking-[-0.025em] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                              {task.title}
                            </h3>
                            {task.source === "agent_plan" ? (
                              <span
                                className="shrink-0 rounded-full border border-[rgba(113,112,255,0.28)] bg-[rgba(113,112,255,0.08)] px-2 py-0.5 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--accent-strong)]"
                                title="Materialized from an approved plan"
                              >
                                plan
                              </span>
                            ) : null}
                          </div>

                          {task.description ? (
                            <p className="mt-2.5 m-0 overflow-hidden text-[0.78rem] leading-[1.55] text-[var(--muted)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                              {task.description}
                            </p>
                          ) : null}

                          {hasCoordination ? (
                            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                              <span className="inline-flex min-h-7 items-center rounded-full border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] tone-accent">
                                {`Agents · ${workspaceAgents.length} mounted`}
                              </span>
                              {task.parentTaskId ? (
                                <span className="inline-flex min-h-7 items-center rounded-full border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] tone-info">
                                  {`Subtask${assignedAgentName ? ` · ${assignedAgentName}` : ""}`}
                                </span>
                              ) : null}
                            </div>
                          ) : null}

                          {!task.parentTaskId && childTasks.length > 0 ? (
                            <div className="mt-3 grid gap-2.5 border-t border-border pt-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="section-kicker">
                                  Coordination subtasks
                                </span>
                                <span className="text-[0.74rem] text-[var(--muted)]">
                                  {childTasks.length} total
                                </span>
                              </div>
                              {(isActive ? childTasks : childTasks.slice(0, 3)).map((childTask) => {
                                const childWorkspaceAgents =
                                  workspaceAgentsByWorkspaceId.get(childTask.workspaceId) ?? [];
                                const childAgentName = resolveWorkspaceAgentName(
                                  childTask,
                                  childWorkspaceAgents
                                );
                                const isReviewSubtask = childTask.column === "review";
                                const isCancelableSubtask =
                                  Boolean(childTask.parentTaskId) &&
                                  !childTask.cancelledAt &&
                                  childTask.column !== "done" &&
                                  childTask.column !== "archived";
                                const canApprove =
                                  isReviewSubtask && childTask.lastRunStatus === "succeeded";
                                return (
                                  <article
                                    key={childTask.id}
                                    className="grid gap-2 rounded-[9px] border border-border bg-[var(--surface-faint)] px-3 py-2.5"
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
                                        <span className="text-[0.84rem] font-medium leading-[1.4]">
                                          {childTask.title}
                                        </span>
                                        <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                                          {childTask.cancelledAt
                                            ? "Cancelled"
                                            : childTask.rejected
                                              ? "Rejected"
                                              : titleCase(childTask.column)}
                                        </span>
                                      </div>
                                      <span className="text-[0.74rem] text-[var(--muted)]">
                                        {childAgentName ?? "Unassigned agent"}
                                      </span>
                                    </button>
                                    {childTask.parentTaskId &&
                                    (isReviewSubtask || isCancelableSubtask) ? (
                                      <SubtaskReviewActions
                                        compact
                                        disabled={reviewActionBusy}
                                        canApprove={canApprove}
                                        showApprove={isReviewSubtask}
                                        showReject={isReviewSubtask}
                                        showRetry={isReviewSubtask}
                                        showCancel={isCancelableSubtask}
                                        onApprove={() => onApproveSubtask(childTask)}
                                        onReject={() =>
                                          (() => {
                                            const reason = window.prompt(
                                              `Why reject "${childTask.title}"? (optional)`,
                                              ""
                                            );
                                            if (reason === null) {
                                              return;
                                            }
                                            onRejectSubtask(childTask, reason || undefined);
                                          })()
                                        }
                                        onRetry={() => onRetrySubtask(childTask)}
                                        onCancel={() => {
                                          if (
                                            !window.confirm(
                                              `Cancel subtask "${childTask.title}"?`
                                            )
                                          ) {
                                            return;
                                          }
                                          onCancelSubtask(childTask);
                                        }}
                                      />
                                    ) : null}
                                  </article>
                                );
                              })}
                              {!isActive && childTasks.length > 3 ? (
                                <span className="text-[0.74rem] text-[var(--muted)]">
                                  +{childTasks.length - 3} more subtasks
                                </span>
                              ) : null}
                            </div>
                          ) : null}

                          {showBlockedBy && blockedByEntries.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {blockedByEntries.map(({ id, title }) => (
                                <span
                                  key={id}
                                  className="inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[0.64rem] tone-warning"
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

                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[0.625rem]">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="min-w-0 truncate text-[0.72rem] leading-[1.3] text-[var(--muted)]">
                                {workspaceName}
                              </span>
                              {showColumnBadge ? (
                                <span
                                  className={cn(
                                    "inline-flex min-h-7 items-center whitespace-nowrap rounded-full border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em]",
                                    taskRunBadge.className
                                  )}
                                >
                                  {taskRunBadge.label}
                                </span>
                              ) : null}
                            </div>

                            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
                              <span className="whitespace-nowrap text-[0.72rem] leading-[1.3] text-[var(--muted)]">
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
