import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CoordinatorProposal,
  Run,
  RunLogEntry,
  Workspace,
  WorkspaceAgent,
  WorkspaceChannel
} from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import type { CoordinationMessage, CoordinationScope } from "@/lib/coordination";
import type { DisplayTask } from "@/lib/task-view";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

import { CoordinatorProposalPanel } from "./CoordinatorProposalPanel";
import { DiffViewer } from "./DiffViewer";
import { LiveLog } from "./LiveLog";
import { SubtaskReviewActions } from "./SubtaskReviewActions";
import { TaskActionBar } from "./TaskActionBar";
import { TeamMessageFeed } from "./TeamMessageFeed";

interface Props {
  workspace: Workspace | null;
  channel: WorkspaceChannel;
  task: DisplayTask | null;
  workspaceAgents: WorkspaceAgent[];
  scope: CoordinationScope;
  messages: CoordinationMessage[];
  messagesLoading?: boolean;
  messagesError?: string | null;
  proposals?: CoordinatorProposal[];
  proposalsLoading?: boolean;
  onSendMessage?(content: string): Promise<unknown>;
  runs?: Run[];
  selectedRunId: string | null;
  runLogLoading?: boolean;
  onSelectRun(runId: string): void;
  liveLog?: RunLogEntry[];
  runLog?: RunLogEntry[];
  onBackToBoard(): void;
  onPlan?(): void;
  onStart?(): void;
  onRequestReview?(): void;
  onStop?(): void;
  onMoveToTodo?(): void;
  onMarkDone?(): void;
  onArchive?(): void;
  onCleanupWorktree?(): void;
  onDelete?(): void;
  onApproveSubtask?(): void;
  onRejectSubtask?(): void;
  onRetrySubtask?(): void;
  onCancelSubtask?(): void;
  reviewActionBusy?: boolean;
}

function channelBadgeTone(kind: WorkspaceChannel["kind"]) {
  return kind === "all" ? "tone-accent" : "tone-muted";
}

function taskStatusTone(task: DisplayTask) {
  switch (task.column) {
    case "running":
      return "tone-warning";
    case "review":
      return "tone-accent";
    case "done":
      return "tone-success";
    case "blocked":
      return "tone-danger";
    default:
      return "tone-muted";
  }
}

function formatRunLabel(run: Run) {
  return `${titleCase(run.status)} · ${formatRelativeTime(run.startedAt)}`;
}

function readRunDebugRows(run: Run): Array<{ label: string; value: string }> {
  return [
    run.command ? { label: "Command", value: run.command } : null,
    run.metadata?.claudeRequestedModel
      ? { label: "Requested model", value: run.metadata.claudeRequestedModel }
      : null,
    run.metadata?.claudeModel
      ? { label: "Resolved model", value: run.metadata.claudeModel }
      : null,
    run.metadata?.claudeSessionId
      ? { label: "Session", value: run.metadata.claudeSessionId }
      : null,
    run.metadata?.claudePermissionMode
      ? { label: "Permission", value: run.metadata.claudePermissionMode }
      : null,
    run.metadata?.claudeTotalCostUsd
      ? { label: "Cost", value: `$${run.metadata.claudeTotalCostUsd}` }
      : null
  ].filter((row): row is { label: string; value: string } => row !== null);
}

function ChannelHeader({
  workspace,
  channel,
  task,
  onBackToBoard
}: {
  workspace: Workspace | null;
  channel: WorkspaceChannel;
  task: DisplayTask | null;
  onBackToBoard(): void;
}) {
  return (
    <header className="grid gap-4 border-b border-border px-4 py-4 lg:px-5 lg:py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onBackToBoard}
            className="inline-flex min-h-8 items-center gap-2 rounded-[9px] border border-border bg-[var(--surface-soft)] px-2.5 text-[0.76rem] font-[510] text-[var(--muted-strong)] transition-[border-color,background-color] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3">
              <path
                d="M9.5 3.5 5 8l4.5 4.5M5.5 8h6"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.4"
              />
            </svg>
            Back to board
          </button>
          <span
            className={cn(
              "inline-flex min-h-8 items-center rounded-full border px-3 font-mono text-[0.66rem] uppercase tracking-[0.08em]",
              channelBadgeTone(channel.kind)
            )}
          >
            {channel.kind === "all" ? "Coordinator channel" : "Task channel"}
          </span>
          {task ? (
            <span
              className={cn(
                "inline-flex min-h-8 items-center rounded-full border px-3 font-mono text-[0.66rem] uppercase tracking-[0.08em]",
                taskStatusTone(task)
              )}
            >
              {titleCase(task.column)}
            </span>
          ) : null}
        </div>
        <span className="text-[0.76rem] text-[var(--muted)]">
          {workspace?.name ?? "Workspace"}
        </span>
      </div>

      <div className="grid gap-1.5">
        <p className="section-kicker m-0">{workspace?.rootPath ?? "Workspace"}</p>
        <h1 className="m-0 text-[2.05rem] leading-[0.94] text-foreground lg:text-[2.35rem]">
          #{channel.slug}
        </h1>
        <p className="m-0 max-w-[52rem] text-[0.84rem] leading-[1.55] text-[var(--muted)]">
          {channel.kind === "all"
            ? "Chat with the mounted coordinator here. Approved proposals spin up new top-level tasks and their own task channels."
            : task?.description || "Execution updates, human follow-ups, and task artifacts collect in this channel."}
        </p>
      </div>
    </header>
  );
}

function TaskInspector({
  task,
  runs,
  selectedRunId,
  onSelectRun,
  liveLog,
  runLog,
  runLogLoading = false,
  onPlan,
  onStart,
  onRequestReview,
  onStop,
  onMoveToTodo,
  onMarkDone,
  onArchive,
  onCleanupWorktree,
  onDelete,
  onApproveSubtask,
  onRejectSubtask,
  onRetrySubtask,
  onCancelSubtask,
  reviewActionBusy = false
}: {
  task: DisplayTask;
  runs: Run[];
  selectedRunId: string | null;
  onSelectRun(runId: string): void;
  liveLog: RunLogEntry[];
  runLog: RunLogEntry[];
  runLogLoading?: boolean;
  onPlan?(): void;
  onStart?(): void;
  onRequestReview?(): void;
  onStop?(): void;
  onMoveToTodo?(): void;
  onMarkDone?(): void;
  onArchive?(): void;
  onCleanupWorktree?(): void;
  onDelete?(): void;
  onApproveSubtask?(): void;
  onRejectSubtask?(): void;
  onRetrySubtask?(): void;
  onCancelSubtask?(): void;
  reviewActionBusy?: boolean;
}) {
  const activeRun = useMemo(
    () => runs.find((run) => run.status === "running") ?? null,
    [runs]
  );
  const viewedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? activeRun ?? runs[0] ?? null,
    [activeRun, runs, selectedRunId]
  );
  const worktreeReady = Boolean(task.worktree.path && task.worktree.status !== "removed");
  const canRequestReview =
    task.column === "review" &&
    !activeRun &&
    Boolean(task.worktree.path && task.worktree.status !== "removed");
  const isReviewableSubtask = Boolean(task.parentTaskId && task.column === "review");
  const isCancelableSubtask = Boolean(
    task.parentTaskId &&
      !task.cancelledAt &&
      task.column !== "done" &&
      task.column !== "archived"
  );

  const diffQuery = useQuery({
    queryKey: ["task-diff", task.id],
    queryFn: async () => api.getTaskDiff(task.id),
    enabled: worktreeReady
  });

  return (
    <>
      <section className="surface-card grid gap-3.5 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <p className="section-kicker m-0">Task inspector</p>
            <h2 className="m-0 text-[1.1rem] leading-[1.3] text-foreground">{task.title}</h2>
          </div>
          <span
            className={cn(
              "inline-flex min-h-8 items-center rounded-full border px-3 font-mono text-[0.64rem] uppercase tracking-[0.08em]",
              taskStatusTone(task)
            )}
          >
            {titleCase(task.column)}
          </span>
        </div>

        <div className="grid gap-3 text-[0.84rem] text-[var(--muted)]">
          <div className="grid gap-1">
            <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em]">
              Runner
            </span>
            <span>{titleCase(task.runnerType)}</span>
          </div>
          {task.pullRequestUrl ? (
            <a
              href={task.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="break-all text-[var(--accent)] no-underline hover:underline"
            >
              {task.pullRequestUrl}
            </a>
          ) : null}
        </div>

        {isReviewableSubtask || isCancelableSubtask ? (
          <SubtaskReviewActions
            canApprove={task.lastRunStatus === "succeeded"}
            showApprove={isReviewableSubtask}
            showReject={isReviewableSubtask}
            showRetry={isReviewableSubtask}
            showCancel={isCancelableSubtask}
            disabled={reviewActionBusy}
            onApprove={onApproveSubtask}
            onReject={onRejectSubtask}
            onRetry={onRetrySubtask}
            onCancel={onCancelSubtask}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <TaskActionBar
              column={task.column}
              task={task}
              compact
              onPlan={() => onPlan?.()}
              onStart={() => onStart?.()}
              onStop={() => onStop?.()}
              onMoveToTodo={() => onMoveToTodo?.()}
              onMarkDone={() => onMarkDone?.()}
              onArchive={() => onArchive?.()}
            />
            {canRequestReview ? (
              <button
                type="button"
                onClick={() => onRequestReview?.()}
                className="inline-flex min-h-8 items-center rounded-full border px-3 text-[0.68rem] font-semibold uppercase tracking-[0.06em] tone-accent transition-[border-color,background-color] hover:border-[rgba(113,112,255,0.52)] hover:bg-[rgba(113,112,255,0.18)]"
              >
                Request review
              </button>
            ) : null}
            {onCleanupWorktree && worktreeReady ? (
              <button
                type="button"
                onClick={onCleanupWorktree}
                className="inline-flex min-h-8 items-center rounded-full border border-border bg-[var(--surface-soft)] px-3 text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-foreground transition-[border-color,background-color] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
              >
                Cleanup worktree
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                onClick={onDelete}
                className="inline-flex min-h-8 items-center rounded-full border px-3 text-[0.68rem] font-semibold uppercase tracking-[0.06em] tone-danger transition-[border-color,background-color] hover:border-[rgba(239,98,108,0.52)] hover:bg-[rgba(239,98,108,0.18)]"
              >
                Delete
              </button>
            ) : null}
          </div>
        )}
      </section>

      <section className="surface-card grid gap-3 px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="grid gap-1">
            <p className="section-kicker m-0">Run history</p>
            <p className="m-0 text-[0.78rem] text-[var(--muted)]">
              Inspect the latest execution, logs, and review output.
            </p>
          </div>
        </div>

        {runs.length === 0 ? (
          <div className="rounded-[var(--radius)] border border-dashed border-border px-4 py-4 text-[0.82rem] text-[var(--muted)]">
            No runs yet for this task.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelectRun(run.id)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-left text-[0.74rem] transition-[border-color,background-color]",
                  viewedRun?.id === run.id
                    ? "border-[var(--border-strong)] bg-[var(--surface-soft)] text-foreground"
                    : "border-border bg-[var(--surface-faint)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
                )}
              >
                {formatRunLabel(run)}
              </button>
            ))}
          </div>
        )}

        {viewedRun ? (
          <div className="rounded-[var(--radius)] border border-border bg-[var(--bg)]">
            <LiveLog
              task={task}
              activeRun={activeRun}
              viewedRun={viewedRun}
              liveLog={liveLog}
              runLog={runLog}
              isLoading={runLogLoading}
            />
          </div>
        ) : null}
      </section>

      {worktreeReady ? (
        <section className="surface-card grid gap-3 px-4 py-4">
          <div className="grid gap-1">
            <p className="section-kicker m-0">Diff inspector</p>
            <p className="m-0 text-[0.78rem] text-[var(--muted)]">
              Changes between {task.worktree.baseRef || "base"} and the task worktree head.
            </p>
          </div>
          <div className="min-h-0 overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--bg)]">
            <DiffViewer
              files={diffQuery.data?.files ?? []}
              baseRef={task.worktree.baseRef || "base"}
              headRef={task.worktree.branchName}
              isLoading={diffQuery.isLoading}
              error={diffQuery.error instanceof Error ? diffQuery.error.message : null}
            />
          </div>
        </section>
      ) : null}
    </>
  );
}

function CoordinatorRuntimeDebug({
  task,
  runs,
  selectedRunId,
  onSelectRun,
  liveLog,
  runLog,
  runLogLoading = false
}: {
  task: DisplayTask | null;
  runs: Run[];
  selectedRunId: string | null;
  onSelectRun(runId: string): void;
  liveLog: RunLogEntry[];
  runLog: RunLogEntry[];
  runLogLoading?: boolean;
}) {
  const activeRun = useMemo(
    () => runs.find((run) => run.status === "running") ?? null,
    [runs]
  );
  const viewedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? activeRun ?? runs[0] ?? null,
    [activeRun, runs, selectedRunId]
  );
  const debugRows = viewedRun ? readRunDebugRows(viewedRun) : [];

  return (
    <section className="surface-card grid gap-3 px-4 py-4">
      <div className="grid gap-1">
        <p className="section-kicker m-0">Coordinator runtime</p>
        <p className="m-0 text-[0.8rem] text-[var(--muted)]">
          Real-time Claude/OpenRouter output from the hidden coordinator run for debugging.
        </p>
      </div>

      {!task ? (
        <div className="rounded-[var(--radius)] border border-dashed border-border px-4 py-4 text-[0.8rem] text-[var(--muted)]">
          The coordinator backing task has not initialized yet. Send a message in `#all` to start the run and stream logs here.
        </div>
      ) : (
        <>
          <div className="grid gap-2 text-[0.78rem] text-[var(--muted)]">
            <div className="flex items-center justify-between gap-2">
              <span>Runner</span>
              <span className="text-right text-foreground">{titleCase(task.runnerType)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Status</span>
              <span className="text-right text-foreground">{titleCase(task.column)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Last update</span>
              <span className="text-right text-foreground">{formatRelativeTime(task.updatedAt)}</span>
            </div>
          </div>

          {runs.length === 0 ? (
            <div className="rounded-[var(--radius)] border border-dashed border-border px-4 py-4 text-[0.8rem] text-[var(--muted)]">
              No coordinator runs yet.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => onSelectRun(run.id)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-left text-[0.72rem] transition-[border-color,background-color]",
                      viewedRun?.id === run.id
                        ? "border-[var(--border-strong)] bg-[var(--surface-soft)] text-foreground"
                        : "border-border bg-[var(--surface-faint)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
                    )}
                  >
                    {formatRunLabel(run)}
                  </button>
                ))}
              </div>

              {debugRows.length > 0 ? (
                <div className="grid gap-2 rounded-[var(--radius)] border border-border bg-[var(--surface-faint)] px-3 py-3 text-[0.74rem]">
                  {debugRows.map((row) => (
                    <div key={row.label} className="grid gap-1">
                      <span className="font-mono text-[0.58rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                        {row.label}
                      </span>
                      <code className="break-all whitespace-pre-wrap font-mono text-[0.7rem] text-foreground">
                        {row.value}
                      </code>
                    </div>
                  ))}
                </div>
              ) : null}

              {viewedRun ? (
                <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--bg)]">
                  <LiveLog
                    task={task}
                    activeRun={activeRun}
                    viewedRun={viewedRun}
                    liveLog={liveLog}
                    runLog={runLog}
                    isLoading={runLogLoading}
                    showStatus={false}
                  />
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  );
}

export function WorkspaceChannelPage({
  workspace,
  channel,
  task,
  workspaceAgents,
  scope,
  messages,
  messagesLoading = false,
  messagesError = null,
  proposals = [],
  proposalsLoading = false,
  onSendMessage,
  runs = [],
  selectedRunId,
  runLogLoading = false,
  onSelectRun,
  liveLog = [],
  runLog = [],
  onBackToBoard,
  onPlan,
  onStart,
  onRequestReview,
  onStop,
  onMoveToTodo,
  onMarkDone,
  onArchive,
  onCleanupWorktree,
  onDelete,
  onApproveSubtask,
  onRejectSubtask,
  onRetrySubtask,
  onCancelSubtask,
  reviewActionBusy = false
}: Props) {
  const workerCount = workspaceAgents.filter((agent) => agent.role === "worker").length;
  const coordinator = workspaceAgents.find((agent) => agent.role === "coordinator") ?? null;

  return (
    <section className="grid h-full min-h-0 gap-4 px-3 pb-3 pt-2.5 sm:px-4 sm:pb-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:px-5 lg:pb-5 lg:pt-3.5">
      <div className="surface-card grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <ChannelHeader
          workspace={workspace}
          channel={channel}
          task={task}
          onBackToBoard={onBackToBoard}
        />

        <div className="min-h-0 overflow-hidden p-4 lg:p-4.5">
          <TeamMessageFeed
            messages={messages}
            loading={messagesLoading}
            error={messagesError}
            onSendMessage={onSendMessage}
            title={channel.kind === "all" ? "Coordinator chat" : "Task timeline"}
            description={
              channel.kind === "all"
                ? "Use this room to brief the coordinator, refine scope, and approve proposed work."
                : "Execution summaries, task artifacts, and human follow-ups stay together here."
            }
            emptyStateLabel={
              channel.kind === "all"
                ? "Start the conversation here to let the coordinator break work into new tasks."
                : "This task channel has not recorded any timeline events yet."
            }
            composerLabel={channel.kind === "all" ? "Message coordinator" : "Reply in channel"}
            placeholder={
              channel.kind === "all"
                ? "Ask the coordinator to break down work, reshape priorities, or start a new task stream..."
                : "Send follow-up context or reply to the latest execution..."
            }
            unavailablePlaceholder="Channel input is unavailable right now."
            footerHint={
              channel.kind === "all"
                ? "Press Ctrl/Cmd+Enter to send a message to the coordinator."
                : "Press Ctrl/Cmd+Enter to post into this task channel."
            }
            fullHeight
          />
        </div>
      </div>

      <aside className="grid min-h-0 auto-rows-max gap-4 overflow-y-auto">
        <section className="surface-card grid gap-3 px-4 py-4">
          <div className="grid gap-1">
            <p className="section-kicker m-0">Channel context</p>
            <h2 className="m-0 text-[1.05rem] leading-[1.35] text-foreground">
              {channel.kind === "all" ? "Workspace frontdoor" : "Execution room"}
            </h2>
          </div>
          <div className="grid gap-2 text-[0.84rem] text-[var(--muted)]">
            <div className="flex items-center justify-between gap-2">
              <span>Coordinator</span>
              <span className="text-right text-foreground">
                {coordinator?.name ?? "Not mounted"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Workers</span>
              <span className="text-right text-foreground">{workerCount}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Created</span>
              <span className="text-right text-foreground">
                {formatRelativeTime(channel.createdAt)}
              </span>
            </div>
          </div>
        </section>

        {channel.kind === "all" ? (
          <>
            <section className="surface-card grid gap-3 px-4 py-4">
              <div className="grid gap-1">
                <p className="section-kicker m-0">Pending proposals</p>
                <p className="m-0 text-[0.8rem] text-[var(--muted)]">
                  Approving a proposal creates new top-level tasks and their task channels.
                </p>
              </div>
              <CoordinatorProposalPanel
                scope={scope}
                proposals={proposals}
                loading={proposalsLoading}
              />
            </section>

            <CoordinatorRuntimeDebug
              task={task}
              runs={runs}
              selectedRunId={selectedRunId}
              onSelectRun={onSelectRun}
              liveLog={liveLog}
              runLog={runLog}
              runLogLoading={runLogLoading}
            />
          </>
        ) : task ? (
          <TaskInspector
            task={task}
            runs={runs}
            selectedRunId={selectedRunId}
            onSelectRun={onSelectRun}
            liveLog={liveLog}
            runLog={runLog}
            runLogLoading={runLogLoading}
            onPlan={onPlan}
            onStart={onStart}
            onRequestReview={onRequestReview}
            onStop={onStop}
            onMoveToTodo={onMoveToTodo}
            onMarkDone={onMarkDone}
            onArchive={onArchive}
            onCleanupWorktree={onCleanupWorktree}
            onDelete={onDelete}
            onApproveSubtask={onApproveSubtask}
            onRejectSubtask={onRejectSubtask}
            onRetrySubtask={onRetrySubtask}
            onCancelSubtask={onCancelSubtask}
            reviewActionBusy={reviewActionBusy}
          />
        ) : (
          <section className="surface-card rounded-[var(--radius)] border border-dashed border-border px-4 py-5 text-[0.82rem] text-[var(--muted)]">
            This task channel is waiting for its task record to appear.
          </section>
        )}
      </aside>
    </section>
  );
}
