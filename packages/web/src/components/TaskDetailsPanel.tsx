import { useMemo } from "react";
import type { Run, RunLogEntry, Workspace } from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import type { DisplayTask } from "@/lib/task-view";
import { LiveLog } from "./LiveLog";
import { TaskActionBar } from "./TaskActionBar";

export type TaskDetailsTab = "overview" | "logs";

interface Props {
  className?: string;
  task: DisplayTask | null;
  tab: TaskDetailsTab;
  runs: Run[];
  workspaces: Workspace[];
  selectedRunId: string | null;
  runLogLoading?: boolean;
  onBack?(): void;
  onTabChange(tab: TaskDetailsTab): void;
  onSelectRun(runId: string): void;
  liveLog: RunLogEntry[];
  runLog: RunLogEntry[];
  onPlan(): void;
  onStart(): void;
  onStop(): void;
  onMoveToTodo(): void;
  onMarkDone(): void;
  onArchive(): void;
  onCleanupWorktree(): void;
  onDelete(): void;
}

function formatRunStatusLabel(run: Run | null, task: DisplayTask): string {
  if (run) {
    return titleCase(run.status);
  }

  if (task.column === "running") {
    return "Running";
  }

  if (task.lastRunId) {
    return "Idle";
  }

  return "Not created";
}

function formatRunStatusCopy(run: Run | null, task: DisplayTask): string {
  if (run?.status === "running") {
    return "This task is actively executing and streaming fresh output.";
  }

  if (run?.status === "failed") {
    return "The latest run failed. Review the log stream before retrying.";
  }

  if (run?.status === "canceled") {
    return "The latest run was canceled or interrupted before completion.";
  }

  if (run?.status === "succeeded") {
    return "The latest run completed successfully.";
  }

  if (run?.status === "queued") {
    return "A run has been queued and will start shortly.";
  }

  if (task.lastRunId) {
    return "No active run right now. You can review history or start the task again.";
  }

  return "This task has not been started yet.";
}

export function TaskDetailsPanel({
  className,
  task,
  tab,
  runs,
  workspaces,
  selectedRunId,
  runLogLoading = false,
  onBack,
  onTabChange,
  onSelectRun,
  liveLog,
  runLog,
  onPlan,
  onStart,
  onStop,
  onMoveToTodo,
  onMarkDone,
  onArchive,
  onCleanupWorktree,
  onDelete
}: Props) {
  const activeRun = useMemo(
    () => runs.find((run) => run.status === "running") ?? null,
    [runs]
  );

  const viewedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? activeRun ?? runs[0] ?? null,
    [activeRun, runs, selectedRunId]
  );

  if (!task) {
    return (
      <aside className={["details-panel", className, "empty-panel"].filter(Boolean).join(" ")}>
        <div className="empty-state">
          <p className="eyebrow">Task details</p>
          <h2>Select a task</h2>
          <p>Task context, run history and live logs will appear here.</p>
        </div>
      </aside>
    );
  }

  const workspace = workspaces.find((entry) => entry.id === task.workspaceId) ?? null;
  const workspaceName = workspace?.name ?? "Unknown workspace";
  const showWorktree = workspace?.isGitRepo ?? false;
  const canCleanupWorktree =
    showWorktree &&
    (task.worktree.status === "ready" || task.worktree.status === "cleanup_pending");
  const runnerConfig =
    task.runnerConfig.type === "shell"
      ? task.runnerConfig.command
      : task.runnerConfig.prompt;

  function handleRunSelect(runId: string) {
    onSelectRun(runId);
    onTabChange("logs");
  }

  return (
    <aside className={["details-panel", className].filter(Boolean).join(" ")}>
      {onBack ? (
        <div className="details-toolbar">
          <button type="button" className="button button-secondary" onClick={onBack}>
            Back to board
          </button>
        </div>
      ) : null}

      <section className="details-hero">
        <div className="details-meta-row">
          <span className="meta-chip">Workspace {workspaceName}</span>
          <span className={`status status-${task.column}`}>{titleCase(task.column)}</span>
          <span className={`pill pill-${task.runnerType}`}>{task.runnerType.toUpperCase()}</span>
          {showWorktree ? (
            <span className={`status status-worktree-${task.worktree.status}`}>
              {titleCase(task.worktree.status)}
            </span>
          ) : null}
        </div>

        <div className="details-title-block">
          <p className="eyebrow">Task details</p>
          <h2>{task.title}</h2>
          <p className="details-subtitle">{workspaceName}</p>
        </div>

        <div className="details-actions">
          <TaskActionBar
            column={task.column}
            onPlan={onPlan}
            onStart={onStart}
            onStop={onStop}
            onMoveToTodo={onMoveToTodo}
            onMarkDone={onMarkDone}
            onArchive={onArchive}
          />
          {canCleanupWorktree ? (
            <button type="button" className="button button-secondary" onClick={onCleanupWorktree}>
              {task.worktree.status === "cleanup_pending" ? "Retry cleanup" : "Remove worktree"}
            </button>
          ) : null}
          <button type="button" className="button button-danger" onClick={onDelete}>
            Delete
          </button>
        </div>

        <div className="details-tabs" role="tablist" aria-label="Task detail sections">
          <button
            type="button"
            className={tab === "overview" ? "tab tab-active" : "tab"}
            role="tab"
            aria-selected={tab === "overview"}
            aria-controls="task-details-panel-overview"
            id="task-details-tab-overview"
            onClick={() => onTabChange("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            className={tab === "logs" ? "tab tab-active" : "tab"}
            role="tab"
            aria-selected={tab === "logs"}
            aria-controls="task-details-panel-logs"
            id="task-details-tab-logs"
            onClick={() => onTabChange("logs")}
          >
            Logs
          </button>
        </div>
      </section>

      {tab === "overview" ? (
        <div
          className="details-body"
          role="tabpanel"
          id="task-details-panel-overview"
          aria-labelledby="task-details-tab-overview"
        >
          <section className="details-section">
            <h3>Description</h3>
            <p className="details-description">{task.description || "No description yet."}</p>
          </section>

          <div className="details-grid">
            <section className="details-section">
              <h3>Run status</h3>
              <div className="active-run">
                <div>
                  <strong>{formatRunStatusLabel(activeRun ?? viewedRun, task)}</strong>
                  <p>{formatRunStatusCopy(activeRun ?? viewedRun, task)}</p>
                </div>
                <span className={`pill pill-${task.runnerType}`}>{task.runnerType}</span>
              </div>
              {viewedRun ? (
                <div className="details-kv">
                  <strong>Viewing run</strong>
                  <code>{viewedRun.id}</code>
                </div>
              ) : null}
            </section>

            <section className="details-section">
              <h3>Snapshot</h3>
              <dl className="details-stats">
                <div>
                  <dt>Status</dt>
                  <dd>{titleCase(task.column)}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{formatRelativeTime(task.updatedAt)}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatRelativeTime(task.createdAt)}</dd>
                </div>
                <div>
                  <dt>Last run</dt>
                  <dd>{task.lastRunId ?? "none"}</dd>
                </div>
              </dl>
            </section>

            <section className="details-section">
              <h3>Runner config</h3>
              <div className="details-kv">
                <strong>{task.runnerConfig.type === "shell" ? "Command" : "Prompt"}</strong>
                <code>{runnerConfig}</code>
              </div>
            </section>

            {showWorktree ? (
              <section className="details-section">
                <h3>Worktree</h3>
                <dl className="details-stats">
                  <div>
                    <dt>Status</dt>
                    <dd>{titleCase(task.worktree.status)}</dd>
                  </div>
                  <div>
                    <dt>Base ref</dt>
                    <dd>{task.worktree.baseRef || "none"}</dd>
                  </div>
                  <div>
                    <dt>Branch</dt>
                    <dd>{task.worktree.branchName}</dd>
                  </div>
                  <div>
                    <dt>Last sync</dt>
                    <dd>
                      {task.worktree.lastSyncedBaseAt
                        ? formatRelativeTime(task.worktree.lastSyncedBaseAt)
                        : "not yet"}
                    </dd>
                  </div>
                </dl>
                <div className="details-kv">
                  <strong>Path</strong>
                  <code>{task.worktree.path ?? "not created"}</code>
                </div>
                {task.worktree.cleanupReason ? (
                  <p className="details-note">{task.worktree.cleanupReason}</p>
                ) : null}
              </section>
            ) : null}
          </div>

          <section className="details-section">
            <h3>Run history</h3>
            <div className="run-list">
              {runs.length === 0 ? (
                <p className="muted">No runs yet.</p>
              ) : (
                runs.map((run) => (
                  <button
                    type="button"
                    key={run.id}
                    className={run.id === viewedRun?.id ? "run-row run-row-active" : "run-row"}
                    onClick={() => handleRunSelect(run.id)}
                  >
                    <span>{titleCase(run.status)}</span>
                    <span>{formatRelativeTime(run.startedAt)}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      ) : (
        <div
          role="tabpanel"
          id="task-details-panel-logs"
          aria-labelledby="task-details-tab-logs"
        >
          <LiveLog
            task={task}
            activeRun={activeRun}
            viewedRun={viewedRun}
            liveLog={liveLog}
            runLog={runLog}
            isLoading={runLogLoading}
          />
        </div>
      )}
    </aside>
  );
}
