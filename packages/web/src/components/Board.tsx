import { useEffect, useState, type CSSProperties } from "react";
import { Draggable, Droppable } from "@hello-pangea/dnd";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  XCircle
} from "lucide-react";
import type { Workspace } from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import { BOARD_COLUMNS, type DisplayTask, type DisplayTaskColumn } from "@/lib/task-view";
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
      className: "task-card-run-running"
    };
  }

  if (task.column === "review") {
    return {
      label: "COMPLETED",
      className: "task-card-run-completed"
    };
  }

  if (task.column === "todo") {
    return {
      label: "TODO",
      className: "task-card-run-todo"
    };
  }

  if (task.column === "done") {
    return {
      label: "DONE",
      className: "task-card-run-done"
    };
  }

  if (task.column === "backlog") {
    return {
      label: "BACKLOG",
      className: "task-card-run-backlog"
    };
  }

  return {
    label: titleCase(task.column),
    className: "task-card-run-idle"
  };
}

function shouldShowColumnBadge(column: DisplayTaskColumn) {
  return column !== "backlog";
}

function getTaskCardToneClass(column: DisplayTaskColumn) {
  switch (column) {
    case "backlog":
      return "task-card-redesign-backlog";
    case "todo":
      return "task-card-redesign-todo";
    case "running":
      return "task-card-redesign-running";
    case "review":
      return "task-card-redesign-review";
    case "done":
      return "task-card-redesign-done";
    case "archived":
      return "task-card-redesign-archived";
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

function getPullRequestCiDisplay(task: DisplayTask) {
  const checks = task.pullRequest?.statusChecks ?? task.pullRequest?.checks;
  const rollupState = task.pullRequest?.statusCheckRollupState?.toUpperCase();
  if (!checks || checks.total < 1) {
    if (rollupState === "SUCCESS") {
      return {
        icon: CheckCircle2,
        className: "pr-compact-stat-success",
        label: "(0/0)"
      };
    }
    if (rollupState === "PENDING" || rollupState === "EXPECTED") {
      return {
        icon: Clock,
        className: "pr-compact-stat-warning",
        label: "(0/0)"
      };
    }
    if (rollupState === "FAILURE" || rollupState === "ERROR") {
      return {
        icon: XCircle,
        className: "pr-compact-stat-danger",
        label: "(0/0)"
      };
    }

    return null;
  }

  if (checks.failed > 0) {
    return {
      icon: XCircle,
      className: "pr-compact-stat-danger",
      label: `(${checks.passed}/${checks.total})`
    };
  }

  if (checks.pending > 0) {
    return {
      icon: Clock,
      className: "pr-compact-stat-warning",
      label: `(${checks.passed}/${checks.total})`
    };
  }

  return {
    icon: CheckCircle2,
    className: "pr-compact-stat-success",
    label: `(${checks.passed}/${checks.total})`
  };
}

function getPullRequestReadinessIndicator(task: DisplayTask): "pending" | "success" | "danger" {
  const pullRequest = task.pullRequest;
  if (!pullRequest) {
    return "pending";
  }

  const mergeable = pullRequest.mergeable?.toUpperCase();
  const mergeStateStatus = pullRequest.mergeStateStatus?.toUpperCase();
  const rollupState = pullRequest.statusCheckRollupState?.toUpperCase();
  const statusChecks = pullRequest.statusChecks ?? pullRequest.checks;
  const unresolvedThreads = pullRequest.unresolvedConversationCount ?? 0;

  const hasFailingChecks =
    (statusChecks?.failed ?? 0) > 0 ||
    rollupState === "FAILURE" ||
    rollupState === "ERROR";
  const hasPendingChecks =
    (statusChecks?.pending ?? 0) > 0 ||
    rollupState === "PENDING" ||
    rollupState === "EXPECTED";
  const hasConflicts = mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY";
  const needsAttention =
    unresolvedThreads > 0 ||
    hasConflicts ||
    hasFailingChecks ||
    mergeStateStatus === "BEHIND" ||
    pullRequest.reviewDecision?.toUpperCase() === "CHANGES_REQUESTED";

  if (needsAttention) {
    return "danger";
  }

  if (hasPendingChecks || mergeable === "UNKNOWN") {
    return "pending";
  }

  if (mergeable === "MERGEABLE") {
    return "success";
  }

  return "pending";
}

function CompactPullRequestStatus({
  task,
  reviewCountdown
}: {
  task: DisplayTask;
  reviewCountdown: ReviewCountdown | null;
}) {
  const pullRequest = task.pullRequest;
  if (!pullRequest || !task.pullRequestUrl) {
    return null;
  }

  const hasConflicts =
    pullRequest.mergeable?.toUpperCase() === "CONFLICTING" ||
    pullRequest.mergeStateStatus?.toUpperCase() === "DIRTY";
  const isApproved = pullRequest.reviewDecision?.toUpperCase() === "APPROVED";
  const changesRequested = pullRequest.reviewDecision?.toUpperCase() === "CHANGES_REQUESTED";
  const isMerged = pullRequest.state?.toUpperCase() === "MERGED";
  const isClosed = pullRequest.state?.toUpperCase() === "CLOSED";
  const threadCount = pullRequest.threadCount ?? 0;
  const unresolvedThreads = pullRequest.unresolvedConversationCount ?? 0;
  const resolvedThreads = Math.max(threadCount - unresolvedThreads, 0);
  const ciDisplay = getPullRequestCiDisplay(task);
  const PullRequestIcon = isMerged ? GitMerge : GitPullRequest;
  const readiness = getPullRequestReadinessIndicator(task);
  const reviewIndicatorTitle =
    reviewCountdown && readiness === "pending"
      ? `Next PR status refresh in ${reviewCountdown.label}`
      : readiness === "success"
        ? "PR is ready to merge"
        : readiness === "danger"
          ? "PR needs attention before it can merge"
          : "PR status is being refreshed";

  return (
    <div className="pr-compact">
      <div className="pr-compact-row">
        <a
          href={task.pullRequestUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className={[
            "pr-compact-link",
            isMerged ? "pr-compact-link-merged" : "",
            isClosed ? "pr-compact-link-closed" : "",
            !isMerged && !isClosed ? "pr-compact-link-open" : ""
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <PullRequestIcon className="pr-compact-link-icon" />
          {pullRequest.number !== undefined ? `#${pullRequest.number}` : "PR"}
        </a>

        {pullRequest.isDraft ? <span className="pr-compact-badge pr-compact-badge-muted">DRAFT</span> : null}

        {hasConflicts ? (
          <span className="pr-compact-badge pr-compact-badge-danger">
            <AlertTriangle className="pr-compact-badge-icon" />
            CONFLICTS
          </span>
        ) : null}

        {ciDisplay ? (
          <span className={["pr-compact-stat", ciDisplay.className].join(" ")}>
            <ciDisplay.icon className="pr-compact-stat-icon" />
            <span>{ciDisplay.label}</span>
          </span>
        ) : null}

        {isApproved ? (
          <span className="pr-compact-badge pr-compact-badge-success">APPROVED</span>
        ) : null}
        {changesRequested ? (
          <span className="pr-compact-badge pr-compact-badge-warning">CHANGES</span>
        ) : null}

        {threadCount > 0 ? (
          <span
            className={[
              "pr-compact-stat",
              unresolvedThreads > 0 ? "pr-compact-stat-warning" : "pr-compact-stat-muted"
            ].join(" ")}
          >
            <MessageSquare className="pr-compact-stat-icon" />
            <span>{`(${resolvedThreads}/${threadCount})`}</span>
          </span>
        ) : null}
      </div>

      <a
        href={task.pullRequestUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        className="pr-compact-title"
        title={pullRequest.title ?? task.pullRequestUrl}
      >
        <span
          className={[
            "pr-compact-title-indicator",
            readiness === "pending" ? "pr-compact-title-indicator-pending" : "",
            readiness === "success" ? "pr-compact-title-indicator-success" : "",
            readiness === "danger" ? "pr-compact-title-indicator-danger" : ""
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={reviewIndicatorTitle}
          title={reviewIndicatorTitle}
          style={
            readiness === "pending" && reviewCountdown
              ? ({
                  "--review-progress": `${reviewCountdown.progress}turn`
                } as CSSProperties)
              : undefined
          }
        >
          {readiness === "success" ? (
            <CheckCircle2 className="pr-compact-title-indicator-icon" />
          ) : null}
          {readiness === "danger" ? (
            <AlertTriangle className="pr-compact-title-indicator-icon" />
          ) : null}
        </span>
        <span className="pr-compact-title-text">{pullRequest.title ?? task.pullRequestUrl}</span>
      </a>
    </div>
  );
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
    <section className="board">
      {BOARD_COLUMNS.map((column) => (
        <Droppable droppableId={column.id} key={column.id}>
          {(provided, snapshot) => (
            <article
              className={[
                "column",
                `column-${column.id}`,
                snapshot.isDraggingOver ? "column-dragging" : ""
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="column-header">
                <h2>{column.title}</h2>
                <span>{grouped[column.id]!.length} cards</span>
              </div>

              <div
                className="column-list"
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
                  const showColumnBadge = shouldShowColumnBadge(task.column);
                  const showCardActions = shouldShowCardActions(task.column, isActive);

                  return (
                    <Draggable draggableId={task.id} index={index} key={task.id}>
                      {(dragProvided, dragSnapshot) => (
                        <article
                          className={[
                            "task-card",
                            "task-card-redesign",
                            getTaskCardToneClass(task.column),
                            isActive ? "task-card-active" : "",
                            dragSnapshot.isDragging ? "task-card-dragging" : ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
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
                          <div className="task-card-redesign-header">
                            <h3 className="task-card-redesign-title">{task.title}</h3>
                          </div>

                          {task.description ? (
                            <p className="task-card-redesign-desc">{task.description}</p>
                          ) : null}

                          {task.pullRequestUrl && task.pullRequest ? (
                            <div className="task-card-redesign-pr">
                              <CompactPullRequestStatus
                                task={task}
                                reviewCountdown={reviewCountdown}
                              />
                            </div>
                          ) : null}

                          <div className="task-card-redesign-footer">
                            <div className="task-card-redesign-footer-meta">
                              <span className="task-card-redesign-workspace">{workspaceName}</span>
                              {showColumnBadge ? (
                                <span
                                  className={[
                                    "task-card-run-badge",
                                    taskRunBadge.className
                                  ]
                                    .filter(Boolean)
                                    .join(" ")}
                                >
                                  {taskRunBadge.label}
                                </span>
                              ) : null}
                            </div>

                            <div className="task-card-redesign-footer-side">
                              <span className="task-card-redesign-time">
                                {formatRelativeTime(task.updatedAt)}
                              </span>
                              {showCardActions ? (
                                <TaskActionBar
                                  column={task.column}
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
