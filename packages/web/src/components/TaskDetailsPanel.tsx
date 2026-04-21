import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentTeam, CoordinatorProposal, Run, RunLogEntry, Workspace, WorkspaceAgent } from "@workhorse/contracts";

import { formatCount, formatRelativeTime, titleCase } from "@/lib/format";
import {
  countWorkspaceWorkers,
  getCoordinatorWorkspaceAgent,
  type CoordinationMessage,
  type CoordinationScope,
  resolveCoordinationAgentName
} from "@/lib/coordination";
import type { DisplayTask } from "@/lib/task-view";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { CoordinatorProposalPanel } from "./CoordinatorProposalPanel";
import { DiffViewer } from "./DiffViewer";
import { LiveLog } from "./LiveLog";
import { SubtaskReviewActions } from "./SubtaskReviewActions";
import { TaskActionBar } from "./TaskActionBar";
import { TeamCard } from "./TeamCard";
import { TeamMessageFeed } from "./TeamMessageFeed";

interface Props {
  className?: string;
  task: DisplayTask | null;
  allTasks: DisplayTask[];
  runs: Run[];
  workspaces: Workspace[];
  legacyTeam: AgentTeam | null;
  workspaceAgents: WorkspaceAgent[];
  coordinationScope: CoordinationScope;
  coordinationMessages: CoordinationMessage[];
  coordinationMessagesLoading?: boolean;
  coordinationMessagesError?: string | null;
  coordinationProposals?: CoordinatorProposal[];
  coordinationProposalsLoading?: boolean;
  selectedRunId: string | null;
  runLogLoading?: boolean;
  onBack?(): void;
  onSelectRun(runId: string): void;
  liveLog: RunLogEntry[];
  runLog: RunLogEntry[];
  onPlan(): void;
  onSendPlanFeedback(text: string): Promise<unknown>;
  onSendCoordinationMessage?(text: string): Promise<unknown>;
  onApproveSubtask?(): void;
  onRejectSubtask?(reason?: string): void;
  onRetrySubtask?(): void;
  onCancelSubtask?(): void;
  reviewActionBusy?: boolean;
  onStart(): void;
  onRequestReview(): void;
  onStop(): void;
  onSendInput(text: string): Promise<unknown>;
  onMoveToTodo(): void;
  onMarkDone(): void;
  onArchive(): void;
  onCleanupWorktree(): void;
  onDelete(): void;
  onSetDependencies(ids: string[]): void;
}

// --- Style constants ---

const detailPanelClass = "grid min-h-0 gap-0 bg-transparent";
const emptyStateClass = "surface-card grid max-w-[34rem] gap-4 px-8 py-10 text-center";
const detailEyebrowClass = "section-kicker m-0";

const fieldLabelClass = "section-kicker m-0 text-[0.68rem]";
const fieldValueClass = "min-w-0 break-words text-[0.92rem] leading-[1.6]";
const fieldMonoClass = "font-mono text-[0.78rem]";

const chipClass =
  "inline-flex min-h-8 items-center rounded-full border px-3 font-mono text-[0.68rem] uppercase tracking-[0.08em]";

const actionBtnClass =
  "inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-lg)] border border-border bg-[var(--panel)] px-4 text-[0.88rem] font-medium text-foreground transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]";

type Tone = "muted" | "info" | "warning" | "accent" | "success" | "danger";

function chipTone(tone: Tone) {
  switch (tone) {
    case "info":
      return "border-[rgba(79,92,98,0.22)] bg-[rgba(79,92,98,0.06)] text-[var(--info)]";
    case "warning":
      return "border-[rgba(166,109,26,0.24)] bg-[rgba(166,109,26,0.08)] text-[var(--warning)]";
    case "accent":
      return "border-[rgba(255,79,0,0.24)] bg-[rgba(255,79,0,0.08)] text-[var(--accent-strong)]";
    case "success":
      return "border-[rgba(47,117,88,0.24)] bg-[rgba(47,117,88,0.08)] text-[var(--success)]";
    case "danger":
      return "border-[rgba(181,74,74,0.28)] bg-[rgba(181,74,74,0.08)] text-[var(--danger)]";
    default:
      return "border-border bg-[var(--surface-soft)] text-[var(--muted)]";
  }
}

function columnTone(column: DisplayTask["column"]): Tone {
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

function runStatusTone(run: Run | null): Tone {
  if (!run) return "muted";
  if (run.status === "running" || run.status === "queued") return "warning";
  if (run.status === "succeeded") return "success";
  if (["failed", "interrupted", "canceled"].includes(run.status)) return "danger";
  return "muted";
}

// --- Run phase grouping ---

type RunPhase = "plan" | "running" | "ai-review";

interface PhaseTab {
  phase: RunPhase;
  label: string;
  latestRun: Run;
}

function classifyRunPhase(run: Run): RunPhase {
  const trigger = run.metadata?.trigger;
  if (trigger === "plan_generation") return "plan";
  if (
    trigger === "auto_ai_review" ||
    trigger === "manual_claude_review" ||
    run.runnerType === "claude"
  ) {
    return "ai-review";
  }
  return "running";
}

function buildPhaseTabs(runs: Run[]): PhaseTab[] {
  const groups = new Map<RunPhase, Run>();

  for (const run of runs) {
    const phase = classifyRunPhase(run);
    const existing = groups.get(phase);
    if (!existing || run.startedAt > existing.startedAt) {
      groups.set(phase, run);
    }
  }

  const order: RunPhase[] = ["plan", "running", "ai-review"];
  const labels: Record<RunPhase, string> = {
    plan: "Plan",
    running: "Running",
    "ai-review": "AI Review"
  };

  return order
    .filter((phase) => groups.has(phase))
    .map((phase) => ({
      phase,
      label: labels[phase],
      latestRun: groups.get(phase)!
    }));
}

function resolvePhaseForRun(run: Run | null, tabs: PhaseTab[]): RunPhase | null {
  if (!run) return tabs[0]?.phase ?? null;
  return classifyRunPhase(run);
}

// --- Helper components ---

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
    <div className={cn("grid min-w-0 gap-1", mono && fieldMonoClass, className)}>
      <div className={fieldLabelClass}>{label}</div>
      <div className={fieldValueClass}>{value}</div>
    </div>
  );
}

function formatPrState(value?: string): string {
  return value ? titleCase(value.toLowerCase()) : "-";
}

function formatPrChecksSummary(pr?: DisplayTask["pullRequest"]): string {
  const checks = pr?.checks;
  if (!checks || checks.total < 1) return "No required checks";
  const parts = [`${checks.passed}/${checks.total} passing`];
  if (checks.failed > 0) parts.push(`${checks.failed} failing`);
  if (checks.pending > 0) parts.push(`${checks.pending} pending`);
  return parts.join(", ");
}

function formatPrFilesSummary(pr?: DisplayTask["pullRequest"]): string {
  const count =
    pr?.changedFiles !== undefined ? pr.changedFiles : pr?.files?.length;
  return count === undefined ? "Sync pending" : formatCount(count, "file");
}

// --- Icons ---

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

// --- Main component ---

export function TaskDetailsPanel({
  className,
  task,
  allTasks,
  runs,
  workspaces,
  legacyTeam,
  workspaceAgents,
  coordinationScope,
  coordinationMessages,
  coordinationMessagesLoading = false,
  coordinationMessagesError = null,
  coordinationProposals = [],
  coordinationProposalsLoading = false,
  selectedRunId,
  runLogLoading = false,
  onBack,
  onSelectRun,
  liveLog,
  runLog,
  onPlan,
  onSendPlanFeedback,
  onSendCoordinationMessage,
  onApproveSubtask,
  onRejectSubtask,
  onRetrySubtask,
  onCancelSubtask,
  reviewActionBusy = false,
  onStart,
  onRequestReview,
  onStop,
  onSendInput,
  onMoveToTodo,
  onMarkDone,
  onArchive,
  onCleanupWorktree,
  onDelete,
  onSetDependencies
}: Props) {
  const activeRun = useMemo(
    () => runs.find((run) => run.status === "running") ?? null,
    [runs]
  );

  const phaseTabs = useMemo(() => buildPhaseTabs(runs), [runs]);

  const viewedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? activeRun ?? runs[0] ?? null,
    [activeRun, runs, selectedRunId]
  );

  const activePhase = useMemo(
    () => resolvePhaseForRun(viewedRun, phaseTabs),
    [viewedRun, phaseTabs]
  );

  const [showFilesTab, setShowFilesTab] = useState(false);

  const worktreeReady = Boolean(task?.worktree?.path && task?.worktree?.status !== "removed");
  const diffQuery = useQuery({
    queryKey: ["task-diff", task?.id ?? ""],
    queryFn: async () => {
      if (!task) return null;
      return api.getTaskDiff(task.id);
    },
    enabled: Boolean(task && worktreeReady)
  });
  const diffFiles = diffQuery.data?.files ?? [];
  const diffAdditions = diffFiles.reduce((sum, f) => sum + f.additions, 0);
  const diffDeletions = diffFiles.reduce((sum, f) => sum + f.deletions, 0);

  if (!task) {
    return (
      <aside className={cn(detailPanelClass, "min-h-[60vh] place-items-center", className)}>
        <div className={emptyStateClass}>
          <p className={detailEyebrowClass}>Task details</p>
          <h2 className="text-[2.4rem]">Select a task</h2>
          <p className="m-0 text-[1rem] leading-[1.6] text-[var(--muted)]">
            Task context, run history and live logs will appear here.
          </p>
        </div>
      </aside>
    );
  }

  const workspace = workspaces.find((entry) => entry.id === task.workspaceId) ?? null;
  const showWorktree = workspace?.isGitRepo ?? false;
  const canCleanupWorktree =
    showWorktree &&
    (task.worktree.status === "ready" || task.worktree.status === "cleanup_pending");
  const isPlanPhaseActive = !showFilesTab && activePhase === "plan";
  const hasPlanRun = phaseTabs.some((tab) => tab.phase === "plan");
  const isPlanRunning = hasPlanRun && activeRun !== null && classifyRunPhase(activeRun) === "plan";
  const canSendPlanFeedback =
    hasPlanRun && !isPlanRunning && !activeRun && (task.column === "backlog" || task.column === "todo");

  const canSendInput =
    (isPlanPhaseActive && canSendPlanFeedback) ||
    (task.runnerType === "codex" &&
      ((activeRun?.id !== undefined && viewedRun?.id === activeRun.id) ||
        (!activeRun && task.column === "review" && viewedRun?.id === task.lastRunId)));
  const inputMode: "running" | "review" | "plan-feedback" | null =
    isPlanPhaseActive && canSendPlanFeedback
      ? "plan-feedback"
      : activeRun?.id !== undefined && viewedRun?.id === activeRun.id
        ? "running"
        : !activeRun && task.column === "review" && viewedRun?.id === task.lastRunId
          ? "review"
          : null;
  const pullRequest = task.pullRequest;
  const showPullRequest = Boolean(task.pullRequestUrl || pullRequest);
  const pullRequestFiles = pullRequest?.files ?? [];
  const changedFiles =
    pullRequest?.changedFiles !== undefined
      ? pullRequest.changedFiles
      : pullRequest?.files?.length;
  const canRequestReview =
    task.column === "review" &&
    !activeRun &&
    Boolean(showWorktree && task.worktree.status !== "removed");
  const hasCoordination = coordinationScope.kind !== "none";
  const isReviewableSubtask = Boolean(hasCoordination && task.parentTaskId && task.column === "review");
  const isCancelableSubtask = Boolean(
    hasCoordination &&
      task.parentTaskId &&
      !task.cancelledAt &&
      task.column !== "done" &&
      task.column !== "archived"
  );
  const canApproveReviewSubtask = task.lastRunStatus === "succeeded";
  const assignedAgentName = resolveCoordinationAgentName({
    task,
    legacyTeam,
    workspaceAgents
  });
  const workspaceCoordinator = getCoordinatorWorkspaceAgent(workspaceAgents);
  const workspaceWorkerCount = countWorkspaceWorkers(workspaceAgents);

  return (
    <aside className={cn(detailPanelClass, className)}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-3 sm:p-4 lg:flex-row lg:p-5">
        <div className="flex w-full flex-none flex-col gap-4 overflow-y-auto lg:w-[360px]">
          <div className="surface-card grid gap-3 px-4 py-4">
            <div className="flex items-center gap-2">
              {onBack ? (
                <button
                  type="button"
                  className={actionBtnClass}
                  onClick={onBack}
                >
                  <ArrowLeftIcon />
                  <span>Back</span>
                </button>
              ) : null}
              <span
                className={cn(
                  chipClass,
                  chipTone(
                    task.rejected
                      ? "danger"
                      : task.cancelledAt
                        ? "warning"
                      : task.column === "backlog" && task.lastRunId
                      ? "warning"
                      : task.column === "todo" && task.plan
                        ? "accent"
                        : columnTone(task.column)
                  )
                )}
              >
                {task.cancelledAt
                  ? "Cancelled"
                  : task.rejected
                  ? "Rejected"
                  : task.column === "backlog" && task.lastRunId
                  ? "Planning"
                  : task.column === "todo" && task.plan
                    ? "Planned"
                  : titleCase(task.column)}
              </span>
            </div>
            <h1 className="m-0 text-[2.25rem] leading-[0.92]">
              {task.title}
            </h1>
          </div>

          <div className="surface-card flex flex-wrap items-center gap-2 px-3 py-3">
            {isReviewableSubtask || isCancelableSubtask ? (
              <SubtaskReviewActions
                canApprove={canApproveReviewSubtask}
                showApprove={isReviewableSubtask}
                showReject={isReviewableSubtask}
                showRetry={isReviewableSubtask}
                showCancel={isCancelableSubtask}
                disabled={reviewActionBusy}
                onApprove={() => onApproveSubtask?.()}
                onReject={() => {
                  const reason = window.prompt(
                    `Why reject "${task.title}"? (optional)`,
                    ""
                  );
                  if (reason === null) {
                    return;
                  }
                  onRejectSubtask?.(reason || undefined);
                }}
                onRetry={() => onRetrySubtask?.()}
                onCancel={() => {
                  if (!window.confirm(`Cancel subtask "${task.title}"?`)) {
                    return;
                  }
                  onCancelSubtask?.();
                }}
              />
            ) : (
              <TaskActionBar
                column={task.column}
                task={task}
                onPlan={onPlan}
                onStart={onStart}
                onStop={onStop}
                onMoveToTodo={onMoveToTodo}
                onMarkDone={onMarkDone}
                onArchive={onArchive}
              />
            )}
            {canRequestReview && !isReviewableSubtask ? (
              <button
                type="button"
                className={cn(
                  actionBtnClass,
                  "border-[rgba(255,79,0,0.28)] bg-[rgba(255,79,0,0.08)] text-[var(--accent-strong)] hover:border-[rgba(255,79,0,0.4)] hover:bg-[rgba(255,79,0,0.14)]"
                )}
                onClick={onRequestReview}
              >
                <span>Request Review</span>
              </button>
            ) : null}
            <button
              type="button"
              className={cn(
                actionBtnClass,
                "ml-auto text-[var(--danger)] hover:border-[rgba(181,74,74,0.32)] hover:bg-[rgba(181,74,74,0.08)]"
              )}
              onClick={onDelete}
            >
              <TrashIcon />
            </button>
          </div>

          <SidebarSection title="Description">
            <p className="m-0 text-[0.95rem] leading-[1.65] text-[var(--muted)]">
              {task.description || "No description provided."}
            </p>
          </SidebarSection>

          {hasCoordination ? (
            <>
              <SidebarSection title="Coordination Context">
                {legacyTeam ? (
                  <TeamCard team={legacyTeam} workspaceName={workspace?.name} compact />
                ) : (
                  <WorkspaceAgentSummary
                    workspaceName={workspace?.name}
                    agents={workspaceAgents}
                    prStrategy={workspace?.prStrategy ?? "independent"}
                    autoApproveSubtasks={workspace?.autoApproveSubtasks ?? false}
                  />
                )}
                <div className="mt-3 grid gap-1 text-[0.72rem] text-[var(--muted)]">
                  {legacyTeam ? <span>Mode · legacy team compatibility</span> : null}
                  {task.parentTaskId ? (
                    <span>Subtask thread · parent {task.parentTaskId}</span>
                  ) : (
                    <span>Coordinator thread · parent task</span>
                  )}
                  {task.rejected ? <span>Decision · rejected</span> : null}
                  {assignedAgentName ? <span>Assigned agent · {assignedAgentName}</span> : null}
                  {!legacyTeam && workspaceCoordinator ? (
                    <span>
                      Workspace coordinator · {workspaceCoordinator.name}
                      {workspaceWorkerCount > 0 ? ` · ${workspaceWorkerCount} workers` : ""}
                    </span>
                  ) : null}
                </div>
              </SidebarSection>

              <SidebarSection title="Coordination Activity">
                <TeamMessageFeed
                  messages={coordinationMessages}
                  loading={coordinationMessagesLoading}
                  error={coordinationMessagesError}
                  onSendMessage={onSendCoordinationMessage}
                />
              </SidebarSection>

              {!task.parentTaskId ? (
                <SidebarSection title="Coordinator Proposals">
                  <CoordinatorProposalPanel
                    scope={coordinationScope}
                    proposals={coordinationProposals}
                    loading={coordinationProposalsLoading}
                  />
                </SidebarSection>
              ) : null}
            </>
          ) : null}

          {/* Dependencies */}
          <DependencyPicker
            task={task}
            allTasks={allTasks}
            onSetDependencies={onSetDependencies}
          />

          {/* Worktree */}
          {showWorktree ? (
            <SidebarSection title="Worktree">
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <SidebarField label="Status" value={titleCase(task.worktree.status)} />
                <SidebarField label="Base ref" value={task.worktree.baseRef || "none"} mono />
              </div>
              <SidebarField
                label="Branch"
                value={task.worktree.branchName}
                mono
                className="mt-2"
              />
              {task.worktree.path ? (
                <SidebarField
                  label="Path"
                  value={task.worktree.path}
                  mono
                  className="mt-2"
                />
              ) : null}
              {canCleanupWorktree ? (
                <button
                  type="button"
                  className={cn(
                    actionBtnClass,
                    "mt-2 w-full justify-center border-border text-[0.7rem]"
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
            </SidebarSection>
          ) : null}

          {/* Pull request */}
          {showPullRequest ? (
            <SidebarSection title="Pull request">
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <SidebarField
                  label="Number"
                  value={pullRequest?.number !== undefined ? `#${pullRequest.number}` : "-"}
                  mono
                />
                <SidebarField
                  label="Merge"
                  value={formatPrState(
                    pullRequest?.mergeStateStatus ?? pullRequest?.mergeable
                  )}
                />
                <SidebarField
                  label="Review"
                  value={formatPrState(pullRequest?.reviewDecision)}
                />
                <SidebarField
                  label="Checks"
                  value={formatPrChecksSummary(pullRequest)}
                />
                <SidebarField label="Files" value={formatPrFilesSummary(pullRequest)} />
              </div>

              {task.pullRequestUrl ? (
                <a
                  className="mt-2 block truncate font-mono text-[0.68rem] text-[var(--accent)] no-underline hover:underline"
                  href={task.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {task.pullRequestUrl}
                </a>
              ) : null}

              {pullRequestFiles.length > 0 ? (
                <div className="mt-2 grid border border-border bg-[var(--surface-soft)]">
                  {pullRequestFiles.slice(0, 10).map((file) => (
                    <div
                      className="flex items-start justify-between gap-2 border-b border-border px-2 py-1.5 last:border-b-0"
                      key={file.path}
                    >
                      <code className="min-w-0 break-all font-mono text-[0.64rem] leading-[1.5]">
                        {file.path}
                      </code>
                      <div className="flex shrink-0 items-center gap-1.5 font-mono text-[0.62rem]">
                        <span className="text-[var(--success)]">+{file.additions ?? 0}</span>
                        <span className="text-[var(--danger)]">-{file.deletions ?? 0}</span>
                      </div>
                    </div>
                  ))}
                  {changedFiles !== undefined && changedFiles > 10 ? (
                    <div className="px-2 py-1.5 text-[0.64rem] text-[var(--muted)]">
                      +{changedFiles - 10} more
                    </div>
                  ) : null}
                </div>
              ) : null}
            </SidebarSection>
          ) : null}
        </div>

        <div className="surface-card flex min-h-[60vh] min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex gap-0 overflow-x-auto border-b border-border px-4">
            {phaseTabs.map((tab) => {
              const isActive = !showFilesTab && activePhase === tab.phase;
              const tone = runStatusTone(tab.latestRun);
              return (
                <button
                  key={tab.phase}
                  type="button"
                  className={cn(
                    "flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[0.82rem] font-medium transition-colors",
                    isActive
                      ? "border-foreground text-foreground"
                      : "border-transparent text-[var(--muted)] hover:text-foreground"
                  )}
                  onClick={() => {
                    setShowFilesTab(false);
                    onSelectRun(tab.latestRun.id);
                  }}
                >
                  {tab.label}
                  <span
                    className={cn(
                      "inline-flex min-h-5 items-center rounded-full border px-1.5 font-mono text-[0.58rem] uppercase tracking-[0.08em]",
                      chipTone(tone)
                    )}
                  >
                    {titleCase(tab.latestRun.status)}
                  </span>
                </button>
              );
            })}

            {showWorktree ? (
              <button
                type="button"
                className={cn(
                  "flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[0.82rem] font-medium transition-colors",
                  showFilesTab
                    ? "border-foreground text-foreground"
                    : "border-transparent text-[var(--muted)] hover:text-foreground"
                )}
                onClick={() => setShowFilesTab(true)}
              >
                {diffFiles.length > 0
                  ? `${diffFiles.length} files changed`
                  : "Files"}
                {diffFiles.length > 0 ? (
                  <>
                    <span className="font-mono text-[0.58rem] text-[var(--success)]">+{diffAdditions}</span>
                    <span className="font-mono text-[0.58rem] text-[var(--danger)]">-{diffDeletions}</span>
                  </>
                ) : null}
              </button>
            ) : null}
          </div>

          {/* Content */}
          {showFilesTab ? (
            <DiffViewer
              files={diffFiles}
              baseRef={diffQuery.data?.baseRef ?? ""}
              headRef={diffQuery.data?.headRef ?? ""}
              isLoading={diffQuery.isLoading}
              error={diffQuery.error ? (diffQuery.error instanceof Error ? diffQuery.error.message : "Failed to load diff") : null}
            />
          ) : (
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
              onSendInput={inputMode === "plan-feedback" ? onSendPlanFeedback : onSendInput}
            />
          )}
        </div>
      </div>
    </aside>
  );
}

function WorkspaceAgentSummary({
  workspaceName,
  agents,
  prStrategy,
  autoApproveSubtasks
}: {
  workspaceName?: string;
  agents: WorkspaceAgent[];
  prStrategy: string;
  autoApproveSubtasks: boolean;
}) {
  const coordinator = getCoordinatorWorkspaceAgent(agents);
  const workerCount = countWorkspaceWorkers(agents);

  return (
    <article className="grid gap-3 rounded-[var(--radius-lg)] border border-border bg-[var(--panel)] p-4 text-left">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex min-h-7 items-center rounded-full border border-[rgba(255,79,0,0.24)] bg-[rgba(255,79,0,0.08)] px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--accent-strong)]">
              Agents
            </span>
            <span className="inline-flex min-h-7 items-center rounded-full border border-border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--muted)]">
              {agents.length} mounted
            </span>
          </div>
          <h3 className="mt-3 m-0 text-[1rem] font-semibold leading-[1.35]">
            {workspaceName ?? "Workspace coordination"}
          </h3>
        </div>
        <span className="rounded-full border border-border px-2.5 py-1 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]">
          {titleCase(prStrategy)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {coordinator ? (
          <span className="inline-flex min-h-7 items-center rounded-full border border-[rgba(255,79,0,0.28)] bg-[rgba(255,79,0,0.08)] px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--accent-strong)]">
            coordinator · {coordinator.name}
          </span>
        ) : (
          <span className="inline-flex min-h-7 items-center rounded-full border border-border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--muted)]">
            no coordinator
          </span>
        )}
        {workerCount > 0 ? (
          <span className="inline-flex min-h-7 items-center rounded-full border border-[rgba(79,92,98,0.24)] bg-[rgba(79,92,98,0.06)] px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--info)]">
            {workerCount} workers
          </span>
        ) : null}
        <span className="inline-flex min-h-7 items-center rounded-full border border-border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--muted)]">
          {autoApproveSubtasks ? "Auto-approve subtasks" : "Manual subtask review"}
        </span>
      </div>
    </article>
  );
}

// --- Sidebar sub-components ---

function DependencyPicker({
  task,
  allTasks,
  onSetDependencies
}: {
  task: DisplayTask;
  allTasks: DisplayTask[];
  onSetDependencies(ids: string[]): void;
}) {
  const [localDeps, setLocalDeps] = useState<string[]>(task.dependencies);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state when server state updates (after successful mutation)
  useEffect(() => {
    setLocalDeps(task.dependencies);
  }, [task.dependencies]);

  // Clear timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const candidates = allTasks.filter(
    (t) => t.id !== task.id && t.workspaceId === task.workspaceId && t.column !== "archived"
  );

  if (candidates.length === 0) {
    return null;
  }

  return (
    <SidebarSection title="Dependencies">
      <div className="grid gap-1">
        {candidates.map((candidate) => {
          const checked = localDeps.includes(candidate.id);
          return (
            <label
              key={candidate.id}
              className="flex cursor-pointer items-start gap-2 rounded-[var(--radius)] px-2 py-2 transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
            >
              <input
                type="checkbox"
                className="mt-[3px] shrink-0 accent-[var(--accent)]"
                checked={checked}
                onChange={() => {
                  const next = checked
                    ? localDeps.filter((id) => id !== candidate.id)
                    : [...localDeps, candidate.id];
                  setLocalDeps(next);
                  if (timerRef.current) clearTimeout(timerRef.current);
                  timerRef.current = setTimeout(() => onSetDependencies(next), 300);
                }}
              />
              <span className="min-w-0 break-words text-[0.88rem] leading-[1.5] text-[var(--muted)]">
                {candidate.title}
              </span>
            </label>
          );
        })}
      </div>
    </SidebarSection>
  );
}

function SidebarSection({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="surface-card px-4 py-4">
      <div className={cn(fieldLabelClass, "mb-3")}>{title}</div>
      {children}
    </section>
  );
}

function SidebarField({
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
    <div className={cn("grid min-w-0 gap-0.5", className)}>
      <div className="font-mono text-[0.58rem] uppercase tracking-[0.1em] text-[var(--muted)]">
        {label}
      </div>
      <div
        className={cn(
          "min-w-0 break-words text-[0.88rem] leading-[1.55]",
          mono && "font-mono text-[0.76rem]"
        )}
      >
        {value}
      </div>
    </div>
  );
}
