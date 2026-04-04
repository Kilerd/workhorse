import { useEffect, useState } from "react";
import { Draggable, Droppable } from "@hello-pangea/dnd";
import type { Workspace } from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import { BOARD_COLUMNS, type DisplayTask, type DisplayTaskColumn } from "@/lib/task-view";
import { cn } from "@/lib/utils";
import { CompactPullRequestStatus } from "./CompactPullRequestStatus";
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
}

const boardClass =
  "grid h-full min-h-0 auto-cols-[minmax(260px,1fr)] grid-flow-col overflow-x-auto overflow-y-hidden bg-[var(--panel)] max-[720px]:auto-cols-[minmax(250px,88vw)]";
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

function getTaskCardToneClass(column: DisplayTaskColumn) {
  switch (column) {
    case "backlog":
      return "border-[rgba(128,146,152,0.28)]";
    case "todo":
      return "border-[rgba(104,199,246,0.28)]";
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

export function Board({
  tasks,
  workspaces,
  reviewMonitor,
  selectedTaskId,
  onTaskOpen,
  onPlan,
  onTaskStart,
  onTaskStop,
  onMoveToTodo,
  onMarkDone,
  onArchive
}: Props) {
  const grouped = BOARD_COLUMNS.reduce((acc, column) => {
    acc[column.id] = tasks
      .filter((task) => task.column === column.id)
      .sort((left, right) => left.order - right.order);
    return acc;
  }, groupTasks());
  const [nowMs, setNowMs] = useState(() => Date.now());
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
                  const reviewCountdown =
                    task.column === "review" && task.pullRequestUrl
                      ? getReviewCountdown(reviewMonitor, nowMs)
                      : null;
                  const taskRunBadge = getTaskRunBadge(task);
                  const showColumnBadge = shouldShowColumnBadge(task.column, task);
                  const showCardActions = shouldShowCardActions(task.column, isActive);

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
