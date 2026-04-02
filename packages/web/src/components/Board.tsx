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

function getReviewCountdown(reviewMonitor: ReviewMonitor, nowMs: number) {
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

function getPullRequestMergeBadge(task: DisplayTask) {
  const pullRequest = task.pullRequest;
  if (!pullRequest) {
    return null;
  }

  const mergeable = pullRequest.mergeable?.toUpperCase();
  const mergeStateStatus = pullRequest.mergeStateStatus?.toUpperCase();

  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
    return {
      label: "Conflicts",
      className: "status-pr-conflicting"
    };
  }

  if (mergeStateStatus === "BEHIND") {
    return {
      label: "Behind",
      className: "status-pr-behind"
    };
  }

  if (mergeable === "MERGEABLE") {
    return {
      label: "Mergeable",
      className: "status-pr-mergeable"
    };
  }

  if (mergeable === "UNKNOWN") {
    return {
      label: "Checking",
      className: "status-pr-checking"
    };
  }

  if (mergeStateStatus) {
    return {
      label: titleCase(mergeStateStatus.toLowerCase()),
      className: "status-pr-checking"
    };
  }

  if (mergeable) {
    return {
      label: titleCase(mergeable.toLowerCase()),
      className: "status-pr-checking"
    };
  }

  return null;
}

function getPullRequestChecksBadge(task: DisplayTask) {
  const checks = task.pullRequest?.checks;
  if (!checks || checks.total < 1) {
    return null;
  }

  if (checks.failed > 0) {
    return {
      label: `Checks ${checks.passed}/${checks.total}`,
      className: "status-pr-checks-fail"
    };
  }

  if (checks.pending > 0) {
    return {
      label: `Checks ${checks.passed}/${checks.total}`,
      className: "status-pr-checks-pending"
    };
  }

  return {
    label: `Checks ${checks.passed}/${checks.total}`,
    className: "status-pr-checks-pass"
  };
}

function isFeaturedColumn(column: DisplayTaskColumn) {
  return column === "running" || column === "review";
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

  return {
    label: titleCase(task.column),
    className: "task-card-run-idle"
  };
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

function CompactPullRequestStatus({ task }: { task: DisplayTask }) {
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
        {pullRequest.title ?? task.pullRequestUrl}
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
                  const showWorktree = workspace?.isGitRepo ?? false;
                  const reviewCountdown =
                    task.column === "review" && task.pullRequestUrl
                      ? getReviewCountdown(reviewMonitor, nowMs)
                      : null;
                  const isFeaturedCard = isFeaturedColumn(task.column);
                  const pullRequestMergeBadge = getPullRequestMergeBadge(task);
                  const pullRequestChecksBadge = getPullRequestChecksBadge(task);
                  const taskRunBadge = getTaskRunBadge(task);

                  return (
                    <Draggable draggableId={task.id} index={index} key={task.id}>
                      {(dragProvided, dragSnapshot) => (
                        <article
                          className={[
                            "task-card",
                            isFeaturedCard ? "task-card-redesign" : "",
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
                          {isFeaturedCard ? (
                            <>
                              <div className="task-card-redesign-header">
                                <h3 className="task-card-redesign-title">{task.title}</h3>
                              </div>

                              {task.description ? (
                                <p className="task-card-redesign-desc">{task.description}</p>
                              ) : null}

                              {task.pullRequestUrl && task.pullRequest ? (
                                <div className="task-card-redesign-pr">
                                  <CompactPullRequestStatus task={task} />
                                </div>
                              ) : null}

                              <div className="task-card-redesign-footer">
                                <span className="task-card-redesign-workspace">{workspaceName}</span>
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
                                <span className="task-card-redesign-time">
                                  {formatRelativeTime(task.updatedAt)}
                                </span>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="task-card-head">
                                <div className="task-card-title">
                                  <div className="task-card-title-row">
                                    {reviewCountdown ? (
                                      <span
                                        className="task-card-review-monitor"
                                        aria-label={`Next PR status refresh in ${reviewCountdown.label}`}
                                        title={`Next PR status refresh in ${reviewCountdown.label}`}
                                        style={
                                          {
                                            "--review-progress": `${reviewCountdown.progress}turn`
                                          } as CSSProperties
                                        }
                                      />
                                    ) : null}
                                    <strong>{task.title}</strong>
                                  </div>
                                  <p className="task-card-desc">
                                    {task.description || "No description"}
                                  </p>
                                </div>
                              </div>

                              <div className="task-card-tags">
                                <span className="meta-token">{workspaceName}</span>
                                <span className={`status status-${task.column}`}>
                                  {titleCase(task.column)}
                                </span>
                                {showWorktree ? (
                                  <span className={`status status-worktree-${task.worktree.status}`}>
                                    {titleCase(task.worktree.status)}
                                  </span>
                                ) : null}
                              </div>

                              {task.column === "review" && task.pullRequestUrl ? (
                                <div className="task-card-pr">
                                  <div className="task-card-pr-row">
                                    <span className="meta-token">PR</span>
                                    {pullRequestMergeBadge ? (
                                      <span
                                        className={`status ${pullRequestMergeBadge.className}`}
                                      >
                                        {pullRequestMergeBadge.label}
                                      </span>
                                    ) : null}
                                    {pullRequestChecksBadge ? (
                                      <span
                                        className={`status ${pullRequestChecksBadge.className}`}
                                      >
                                        {pullRequestChecksBadge.label}
                                      </span>
                                    ) : null}
                                  </div>
                                  <a
                                    className="task-pr-link"
                                    href={task.pullRequestUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => event.stopPropagation()}
                                  >
                                    {task.pullRequestUrl}
                                  </a>
                                </div>
                              ) : null}

                              <div className="task-card-footer">
                                <span className="task-card-time">
                                  Updated {formatRelativeTime(task.updatedAt)}
                                </span>
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
                              </div>
                            </>
                          )}
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
