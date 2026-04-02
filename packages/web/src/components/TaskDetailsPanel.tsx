import { useMemo, type ReactNode } from "react";
import type { Run, RunLogEntry, Workspace } from "@workhorse/contracts";

import { formatCount, formatRelativeTime, titleCase } from "@/lib/format";
import type { DisplayTask } from "@/lib/task-view";
import { cn } from "@/lib/utils";
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

const detailPanelClass = "grid min-h-0 gap-0 border-0 bg-[var(--bg)]";
const emptyStateClass = "grid max-w-[32rem] gap-3 text-center";
const detailEyebrowClass =
  "m-0 font-mono text-[0.64rem] uppercase tracking-[0.14em] text-[var(--accent)]";
const detailSectionClass = "rounded-none border border-border bg-[var(--panel)]";
const detailSectionHeaderClass = "border-b border-border p-3";
const detailSectionBodyClass = "grid gap-3 p-3";
const detailFieldClass = "grid min-w-0 gap-1";
const detailFieldLabelClass =
  "m-0 font-mono text-[0.58rem] uppercase tracking-[0.14em] text-[var(--accent)]";
const detailFieldValueClass = "min-w-0 break-words text-[0.82rem] leading-[1.5]";
const detailFieldMonoClass = "font-mono text-[0.72rem]";
const detailChipClass =
  "inline-flex min-h-5 items-center rounded-none border px-1.5 font-mono text-[0.58rem] uppercase tracking-[0.1em]";
const detailButtonClass =
  "inline-flex min-h-7 items-center gap-1.5 rounded-none border border-transparent bg-transparent px-2.5 text-[0.75rem] text-foreground transition-[border-color,background-color,transform] hover:-translate-y-px hover:bg-[var(--surface-soft)]";
type TaskDetailTone = "muted" | "info" | "warning" | "accent" | "success" | "danger";

function getTaskDetailChipToneClass(tone: TaskDetailTone) {
  switch (tone) {
    case "info":
      return "border-[rgba(104,199,246,0.24)] bg-[rgba(104,199,246,0.12)] text-[var(--info)]";
    case "warning":
      return "border-[rgba(242,195,92,0.24)] bg-[rgba(242,195,92,0.12)] text-[var(--warning)]";
    case "accent":
      return "border-[rgba(73,214,196,0.24)] bg-[rgba(73,214,196,0.12)] text-[var(--accent-strong)]";
    case "success":
      return "border-[rgba(99,216,158,0.24)] bg-[rgba(99,216,158,0.12)] text-[var(--success)]";
    case "danger":
      return "border-[rgba(240,113,113,0.28)] bg-[rgba(240,113,113,0.12)] text-[var(--danger)]";
    default:
      return "border-border bg-[var(--surface-soft)] text-[var(--muted)]";
  }
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

function getColumnTone(column: DisplayTask["column"]): TaskDetailTone {
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

function getRunTone(run: Run | null, task: DisplayTask): TaskDetailTone {
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
    <section className={detailSectionClass}>
      <div className={detailSectionHeaderClass}>
        <h3 className="m-0 text-[0.78rem] font-semibold">{title}</h3>
      </div>
      <div className={detailSectionBodyClass}>{children}</div>
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
      className={cn(detailFieldClass, mono && detailFieldMonoClass, className)}
    >
      <div className={detailFieldLabelClass}>{label}</div>
      <div className={detailFieldValueClass}>{value}</div>
    </div>
  );
}

function formatPullRequestState(value?: string): string {
  if (!value) {
    return "-";
  }

  return titleCase(value.toLowerCase());
}

function getPullRequestChangedFilesCount(
  pullRequest?: DisplayTask["pullRequest"]
): number | undefined {
  if (pullRequest?.changedFiles !== undefined) {
    return pullRequest.changedFiles;
  }

  return pullRequest?.files?.length;
}

function formatPullRequestChecksSummary(
  pullRequest?: DisplayTask["pullRequest"]
): string {
  const checks = pullRequest?.checks;
  if (!checks || checks.total < 1) {
    return "No required checks";
  }

  const parts = [`${checks.passed}/${checks.total} passing`];
  if (checks.failed > 0) {
    parts.push(`${checks.failed} failing`);
  }
  if (checks.pending > 0) {
    parts.push(`${checks.pending} pending`);
  }

  return parts.join(", ");
}

function formatPullRequestFilesSummary(
  pullRequest?: DisplayTask["pullRequest"]
): string {
  const changedFiles = getPullRequestChangedFilesCount(pullRequest);
  if (changedFiles === undefined) {
    return "Sync pending";
  }

  return formatCount(changedFiles, "file");
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3 shrink-0">
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
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3 shrink-0">
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
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3 shrink-0">
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
      <aside className={cn(detailPanelClass, "min-h-[60vh] place-items-center", className)}>
        <div className={emptyStateClass}>
          <p className={detailEyebrowClass}>Task details</p>
          <h2>Select a task</h2>
          <p className="m-0 text-[var(--muted)]">
            Task context, run history and live logs will appear here.
          </p>
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
  const pullRequest = task.pullRequest;
  const showPullRequest = Boolean(task.pullRequestUrl || pullRequest);
  const pullRequestFiles = pullRequest?.files ?? [];
  const changedFiles = getPullRequestChangedFilesCount(pullRequest);

  return (
    <aside className={cn(detailPanelClass, className)}>
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-4 border-b border-border bg-[var(--panel)] px-4 max-[720px]:flex-col max-[720px]:items-stretch max-[720px]:p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {onBack ? (
            <>
              <button
                type="button"
                className={cn(detailButtonClass, "hover:border-border")}
                onClick={onBack}
              >
                <ArrowLeftIcon />
                <span>Back to board</span>
              </button>
              <span className="text-[rgba(140,161,160,0.4)] max-[720px]:hidden" aria-hidden="true">
                |
              </span>
            </>
          ) : null}

          <span className="m-0 font-mono text-[0.58rem] uppercase tracking-[0.14em] text-[var(--muted)]">
            Workspace {workspaceName}
          </span>
          <span
            className={cn(detailChipClass, getTaskDetailChipToneClass(getColumnTone(task.column)))}
          >
            {titleCase(task.column)}
          </span>
          <span
            className={cn(
              detailChipClass,
              getTaskDetailChipToneClass(task.runnerType === "codex" ? "accent" : "warning")
            )}
          >
            {task.runnerType}
          </span>
          <span className={cn(detailChipClass, getTaskDetailChipToneClass(runTone))}>
            {formatRunStatusLabel(summaryRun, task)}
          </span>
        </div>

        <button
          type="button"
          className={cn(
            detailButtonClass,
            "text-[var(--danger)] hover:border-[rgba(240,113,113,0.28)] hover:bg-[rgba(240,113,113,0.1)]"
          )}
          onClick={onDelete}
        >
          <TrashIcon />
          <span>Delete</span>
        </button>
      </div>

      <div className="flex flex-col gap-4 border-b border-border bg-[var(--panel)] p-4 min-[721px]:flex-row min-[721px]:items-start min-[721px]:justify-between max-[720px]:p-3">
        <div className="grid min-w-0 gap-1">
          <p className={detailFieldLabelClass}>Task details</p>
          <h1 className="m-0 text-[clamp(1.2rem,1.8vw,1.55rem)] font-semibold leading-[1.08] tracking-[-0.025em]">
            {task.title}
          </h1>
          <p className="m-0 text-[var(--muted)]">{workspaceName}</p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 max-[720px]:items-start">
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
              className={cn(
                detailButtonClass,
                "border-border bg-transparent hover:border-[var(--border-strong)]"
              )}
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

      <div className="flex min-h-0 flex-1 overflow-hidden max-[1040px]:flex-col">
        <div className="grid w-[360px] flex-none content-start gap-4 overflow-y-auto border-r border-border bg-[var(--bg)] p-4 max-[1040px]:w-full max-[1040px]:border-b max-[1040px]:border-r-0 max-[720px]:p-3">
          <DetailSection title="Description">
            <p className="m-0 text-[var(--muted)]">{task.description || "No description provided."}</p>
          </DetailSection>

          <DetailSection title="Run status">
            <div className="flex flex-col gap-3 min-[721px]:flex-row min-[721px]:items-start min-[721px]:justify-between">
              <div className="grid gap-1">
                <div className="text-[0.86rem] font-semibold">
                  {formatRunStatusLabel(summaryRun, task)}
                </div>
                <p className="m-0 text-[var(--muted)]">{formatRunStatusCopy(summaryRun, task)}</p>
              </div>
              <span
                className={cn(
                  detailChipClass,
                  getTaskDetailChipToneClass(task.runnerType === "codex" ? "accent" : "warning")
                )}
              >
                {task.runnerType}
              </span>
            </div>

            {viewedRun ? (
              <div className="grid gap-1.5 border-t border-border pt-3">
                <div className={detailFieldLabelClass}>Viewing run</div>
                <div className={cn(detailFieldValueClass, detailFieldMonoClass)}>
                  {viewedRun.id}
                </div>
              </div>
            ) : null}
          </DetailSection>

          <DetailSection title="Snapshot">
            <div className="grid grid-cols-2 gap-3 max-[1040px]:grid-cols-1">
              <DetailField label="Status" value={titleCase(task.column)} />
              <DetailField label="Updated" value={formatRelativeTime(task.updatedAt)} />
              <DetailField label="Created" value={formatRelativeTime(task.createdAt)} />
              <DetailField label="Last run" value={formatCompactId(task.lastRunId)} mono />
            </div>
          </DetailSection>

          {showWorktree ? (
            <DetailSection title="Worktree">
              <div className="grid grid-cols-2 gap-3 max-[1040px]:grid-cols-1">
                <DetailField label="Status" value={titleCase(task.worktree.status)} />
                <DetailField label="Base ref" value={task.worktree.baseRef || "none"} mono />
                <DetailField
                  label="Branch"
                  value={task.worktree.branchName}
                  mono
                  className="col-span-2 max-[1040px]:col-span-1"
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

              <div className="grid gap-1.5 border-t border-border pt-3">
                <div className={detailFieldLabelClass}>Path</div>
                <div className={cn(detailFieldValueClass, detailFieldMonoClass)}>
                  {task.worktree.path ?? "not created"}
                </div>
              </div>

              {task.worktree.cleanupReason ? (
                <p className="m-0 border-t border-border pt-3 text-[var(--muted)]">
                  {task.worktree.cleanupReason}
                </p>
              ) : null}
            </DetailSection>
          ) : null}

          {showPullRequest ? (
            <DetailSection title="Pull request">
              <div className="grid grid-cols-2 gap-3 max-[1040px]:grid-cols-1">
                <DetailField
                  label="Number"
                  value={pullRequest?.number !== undefined ? `#${pullRequest.number}` : "-"}
                  mono
                />
                <DetailField
                  label="Merge"
                  value={formatPullRequestState(
                    pullRequest?.mergeStateStatus ?? pullRequest?.mergeable
                  )}
                />
                <DetailField
                  label="Review"
                  value={formatPullRequestState(pullRequest?.reviewDecision)}
                />
                <DetailField
                  label="Checks"
                  value={formatPullRequestChecksSummary(pullRequest)}
                />
                <DetailField label="Files" value={formatPullRequestFilesSummary(pullRequest)} />
              </div>

              {task.pullRequestUrl ? (
                <div className="grid gap-1.5 border-t border-border pt-3">
                  <div className={detailFieldLabelClass}>Link</div>
                  <a
                    className={cn(
                      detailFieldValueClass,
                      detailFieldMonoClass,
                      "text-[var(--accent)] no-underline hover:underline"
                    )}
                    href={task.pullRequestUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {task.pullRequestUrl}
                  </a>
                </div>
              ) : null}

              <div className="grid gap-2 border-t border-border pt-3">
                <div className={detailFieldLabelClass}>
                  {changedFiles === undefined
                    ? "Files changed"
                    : `Files changed (${formatCount(changedFiles, "file")})`}
                </div>

                {pullRequestFiles.length > 0 ? (
                  <>
                    <div className="grid border border-border bg-[var(--surface-soft)]">
                      {pullRequestFiles.map((file) => (
                        <div
                          className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-3 last:border-b-0"
                          key={file.path}
                        >
                          <code className="m-0 break-words font-mono text-[0.72rem] leading-[1.5] text-foreground">
                            {file.path}
                          </code>
                          <div className="flex items-center gap-2" aria-label={`${file.path} stats`}>
                            <span className="font-mono text-[0.7rem] text-[var(--success)]">
                              +{file.additions ?? 0}
                            </span>
                            <span className="font-mono text-[0.7rem] text-[var(--danger)]">
                              -{file.deletions ?? 0}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {changedFiles !== undefined && changedFiles > pullRequestFiles.length ? (
                      <p className="m-0 text-[0.72rem] leading-[1.5] text-[var(--muted)]">
                        Showing {formatCount(pullRequestFiles.length, "file")} of{" "}
                        {formatCount(changedFiles, "file")} reported by GitHub.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="m-0 text-[var(--muted)]">
                    {changedFiles === 0
                      ? "No changed files reported by GitHub."
                      : "Waiting for GitHub to sync file changes."}
                  </p>
                )}
              </div>
            </DetailSection>
          ) : null}

          <DetailSection title="Runner config">
            <div className={detailFieldLabelClass}>
              {task.runnerConfig.type === "shell" ? "Command" : "Prompt"}
            </div>
            <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words border border-border bg-[var(--surface-soft)] p-3 font-mono text-[0.72rem] leading-[1.6] text-[var(--muted)]">
              {runnerConfig}
            </pre>
          </DetailSection>

          <DetailSection title="Run history">
            {runs.length === 0 ? (
              <p className="m-0 text-[var(--muted)]">No runs yet.</p>
            ) : (
              <div className="border border-border">
                {runs.map((run) => (
                  <button
                    type="button"
                    key={run.id}
                    className={cn(
                      "flex min-h-[34px] w-full items-center justify-between gap-3 border-b border-border bg-transparent px-3 text-left text-[0.75rem] text-foreground transition-[background-color,color] last:border-b-0 hover:bg-[var(--surface-hover)]",
                      run.id === viewedRun?.id && "bg-[var(--accent-soft)]"
                    )}
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

        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--surface-faint)]">
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
