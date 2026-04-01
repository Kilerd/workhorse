import { useMemo, type ReactNode } from "react";
import type { Run, RunLogEntry, Workspace } from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import type { DisplayTask } from "@/lib/task-view";
import { LiveLog } from "./LiveLog";
import { TaskActionBar } from "./TaskActionBar";

interface Props {
  className?: string;
  task: DisplayTask | null;
  runs: Run[];
  workspaces: Workspace[];
  selectedRunId: string | null;
  runLogLoading?: boolean;
  onBack?(): void;
  onSelectRun(runId: string): void;
  liveLog: RunLogEntry[];
  runLog: RunLogEntry[];
  onPlan(): void;
  onStart(): void;
  onStop(): void;
  onSendInput(text: string): Promise<unknown>;
  onMoveToTodo(): void;
  onMarkDone(): void;
  onArchive(): void;
  onCleanupWorktree(): void;
  onDelete(): void;
}

function formatRunStatusLabel(run: Run | null, task: DisplayTask): string {
  if (run) {
    switch (run.status) {
      case "succeeded":
        return "Completed";
      case "canceled":
        return "Canceled";
      case "interrupted":
        return "Interrupted";
      default:
        return titleCase(run.status);
    }
  }

  if (task.column === "running") {
    return "Running";
  }

  if (task.lastRunId) {
    return "Ready";
  }

  return "Ready";
}

function formatRunStatusCopy(run: Run | null, task: DisplayTask): string {
  if (run?.status === "running") {
    return "This task is actively executing and streaming fresh output.";
  }

  if (run?.status === "failed") {
    return "The latest run failed. Review the log stream before retrying.";
  }

  if (run?.status === "interrupted") {
    return task.runnerType === "codex"
      ? "The latest run was interrupted. Starting it again will resume the previous Codex session when possible."
      : "The latest run was interrupted before completion. Start it again to continue the work.";
  }

  if (run?.status === "canceled") {
    return "The latest run was canceled before completion.";
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

function getColumnTone(column: DisplayTask["column"]): string {
  switch (column) {
    case "todo":
      return "info";
    case "running":
      return "warning";
    case "review":
      return "accent";
    case "done":
      return "success";
    default:
      return "muted";
  }
}

function getRunTone(run: Run | null, task: DisplayTask): string {
  if (run?.status === "running" || (!run && task.column === "running")) {
    return "warning";
  }

  if (run?.status === "succeeded") {
    return "success";
  }

  if (run?.status === "queued") {
    return "info";
  }

  if (run && ["failed", "interrupted", "canceled"].includes(run.status)) {
    return "danger";
  }

  return "muted";
}

function formatCompactId(value?: string): string {
  if (!value) {
    return "-";
  }

  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 8)}...`;
}

function DetailSection({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="task-detail-section">
      <div className="task-detail-section-header">
        <h3>{title}</h3>
      </div>
      <div className="task-detail-section-body">{children}</div>
    </section>
  );
}

function DetailField({
  label,
  value,
  mono = false,
  className
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div
      className={[
        "task-detail-field",
        mono ? "task-detail-field-mono" : null,
        className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="task-detail-field-label">{label}</div>
      <div className="task-detail-field-value">{value}</div>
    </div>
  );
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="task-detail-icon">
      <path
        d="M9.5 3.5 5 8l4.5 4.5M5.5 8h6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function FolderRemoveIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="task-detail-icon">
      <path
        d="M1.5 4.5h4l1.4 1.5h7.6v5.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
      <path
        d="M5.5 9.5h5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="task-detail-icon">
      <path
        d="M3.5 4.5h9m-7.5 0v7m3-7v7m3-7-.4 7.2a1 1 0 0 1-1 .8H6.4a1 1 0 0 1-1-.8L5 4.5m1.5 0 .5-1h2l.5 1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

export function TaskDetailsPanel({
  className,
  task,
  runs,
  workspaces,
  selectedRunId,
  runLogLoading = false,
  onBack,
  onSelectRun,
  liveLog,
  runLog,
  onPlan,
  onStart,
  onStop,
  onSendInput,
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
  const summaryRun = activeRun ?? viewedRun;
  const runTone = getRunTone(summaryRun, task);
  const canSendInput =
    task.runnerType === "codex" &&
    ((activeRun?.id !== undefined && viewedRun?.id === activeRun.id) ||
      (!activeRun && task.column === "review" && viewedRun?.id === task.lastRunId));
  const inputMode =
    activeRun?.id !== undefined && viewedRun?.id === activeRun.id
      ? "running"
      : !activeRun && task.column === "review" && viewedRun?.id === task.lastRunId
        ? "review"
        : null;

  return (
    <aside className={["details-panel", className].filter(Boolean).join(" ")}>
      <div className="task-detail-subheader">
        <div className="task-detail-subheader-main">
          {onBack ? (
            <>
              <button
                type="button"
                className="task-detail-back-button"
                onClick={onBack}
              >
                <ArrowLeftIcon />
                <span>Back to board</span>
              </button>
              <span className="task-detail-divider" aria-hidden="true">
                |
              </span>
            </>
          ) : null}

          <span className="task-detail-workspace-label">Workspace {workspaceName}</span>
          <span className={`task-detail-chip task-detail-chip-column-${getColumnTone(task.column)}`}>
            {titleCase(task.column)}
          </span>
          <span className={`task-detail-chip task-detail-chip-runner-${task.runnerType}`}>
            {task.runnerType}
          </span>
          <span className={`task-detail-chip task-detail-chip-run-${runTone}`}>
            {formatRunStatusLabel(summaryRun, task)}
          </span>
        </div>

        <button type="button" className="task-detail-delete-button" onClick={onDelete}>
          <TrashIcon />
          <span>Delete</span>
        </button>
      </div>

      <div className="task-detail-header">
        <div className="task-detail-heading">
          <p className="task-detail-eyebrow">Task details</p>
          <h1>{task.title}</h1>
          <p className="task-detail-subtitle">{workspaceName}</p>
        </div>

        <div className="task-detail-header-actions">
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
            <button
              type="button"
              className="task-detail-inline-button"
              onClick={onCleanupWorktree}
            >
              <FolderRemoveIcon />
              <span>
                {task.worktree.status === "cleanup_pending"
                  ? "Retry cleanup"
                  : "Remove worktree"}
              </span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="task-detail-layout">
        <div className="task-detail-sidebar">
          <DetailSection title="Description">
            <p className="task-detail-description">{task.description || "No description provided."}</p>
          </DetailSection>

          <DetailSection title="Run status">
            <div className="task-detail-run-overview">
              <div className="task-detail-run-copy-block">
                <div className="task-detail-run-label">{formatRunStatusLabel(summaryRun, task)}</div>
                <p className="task-detail-run-copy">{formatRunStatusCopy(summaryRun, task)}</p>
              </div>
              <span className={`task-detail-chip task-detail-chip-runner-${task.runnerType}`}>
                {task.runnerType}
              </span>
            </div>

            {viewedRun ? (
              <div className="task-detail-inline-block">
                <div className="task-detail-field-label">Viewing run</div>
                <div className="task-detail-inline-value task-detail-inline-value-mono">
                  {viewedRun.id}
                </div>
              </div>
            ) : null}
          </DetailSection>

          <DetailSection title="Snapshot">
            <div className="task-detail-field-grid">
              <DetailField label="Status" value={titleCase(task.column)} />
              <DetailField label="Updated" value={formatRelativeTime(task.updatedAt)} />
              <DetailField label="Created" value={formatRelativeTime(task.createdAt)} />
              <DetailField label="Last run" value={formatCompactId(task.lastRunId)} mono />
            </div>
          </DetailSection>

          {showWorktree ? (
            <DetailSection title="Worktree">
              <div className="task-detail-field-grid">
                <DetailField label="Status" value={titleCase(task.worktree.status)} />
                <DetailField label="Base ref" value={task.worktree.baseRef || "none"} mono />
                <DetailField
                  label="Branch"
                  value={task.worktree.branchName}
                  mono
                  className="task-detail-field-span-2"
                />
                <DetailField
                  label="Last sync"
                  value={
                    task.worktree.lastSyncedBaseAt
                      ? formatRelativeTime(task.worktree.lastSyncedBaseAt)
                      : "not yet"
                  }
                />
              </div>

              <div className="task-detail-inline-block">
                <div className="task-detail-field-label">Path</div>
                <div className="task-detail-inline-value task-detail-inline-value-mono">
                  {task.worktree.path ?? "not created"}
                </div>
              </div>

              {task.worktree.cleanupReason ? (
                <p className="task-detail-note">{task.worktree.cleanupReason}</p>
              ) : null}
            </DetailSection>
          ) : null}

          <DetailSection title="Runner config">
            <div className="task-detail-field-label">
              {task.runnerConfig.type === "shell" ? "Command" : "Prompt"}
            </div>
            <pre className="task-detail-config-block">{runnerConfig}</pre>
          </DetailSection>

          <DetailSection title="Run history">
            {runs.length === 0 ? (
              <p className="task-detail-empty-copy">No runs yet.</p>
            ) : (
              <div className="task-detail-run-history">
                {runs.map((run) => (
                  <button
                    type="button"
                    key={run.id}
                    className={
                      run.id === viewedRun?.id
                        ? "task-detail-run-row task-detail-run-row-active"
                        : "task-detail-run-row"
                    }
                    onClick={() => onSelectRun(run.id)}
                  >
                    <span>{formatRunStatusLabel(run, task)}</span>
                    <span>{formatRelativeTime(run.startedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </DetailSection>
        </div>

        <div className="task-detail-log-pane">
          <LiveLog
            task={task}
            activeRun={activeRun}
            viewedRun={viewedRun}
            liveLog={liveLog}
            runLog={runLog}
            isLoading={runLogLoading}
            showStatus={false}
            canSendInput={canSendInput}
            inputMode={inputMode}
            onSendInput={onSendInput}
          />
        </div>
      </div>
    </aside>
  );
}
