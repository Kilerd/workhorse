import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentTeam, Run, RunLogEntry, TeamMessage, Workspace } from "@workhorse/contracts";

import { formatCount, formatRelativeTime, titleCase } from "@/lib/format";
import type { DisplayTask } from "@/lib/task-view";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { DiffViewer } from "./DiffViewer";
import { LiveLog } from "./LiveLog";
import { TaskActionBar } from "./TaskActionBar";
import { TeamCard } from "./TeamCard";
import { TeamMessageFeed } from "./TeamMessageFeed";

interface Props {
  className?: string;
  task: DisplayTask | null;
  allTasks: DisplayTask[];
  runs: Run[];
  workspaces: Workspace[];
  team: AgentTeam | null;
  teamMessages: TeamMessage[];
  teamMessagesLoading?: boolean;
  teamMessagesError?: string | null;
  selectedRunId: string | null;
  runLogLoading?: boolean;
  onBack?(): void;
  onSelectRun(runId: string): void;
  liveLog: RunLogEntry[];
  runLog: RunLogEntry[];
  onPlan(): void;
  onSendPlanFeedback(text: string): Promise<unknown>;
  onSendTeamMessage?(text: string): Promise<unknown>;
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

const detailPanelClass = "grid min-h-0 gap-0 border-0 bg-[var(--bg)]";
const emptyStateClass = "grid max-w-[32rem] gap-3 text-center";
const detailEyebrowClass =
  "m-0 font-mono text-[0.64rem] uppercase tracking-[0.14em] text-[var(--accent)]";

const fieldLabelClass =
  "m-0 font-mono text-[0.58rem] uppercase tracking-[0.14em] text-[var(--accent)]";
const fieldValueClass = "min-w-0 break-words text-[0.82rem] leading-[1.5]";
const fieldMonoClass = "font-mono text-[0.72rem]";

const chipClass =
  "inline-flex min-h-5 items-center rounded-none border px-1.5 font-mono text-[0.58rem] uppercase tracking-[0.1em]";

const actionBtnClass =
  "inline-flex min-h-7 items-center gap-1.5 rounded-none border border-transparent bg-transparent px-2.5 text-[0.75rem] text-foreground transition-[border-color,background-color,transform] hover:-translate-y-px hover:bg-[var(--surface-soft)]";

type Tone = "muted" | "info" | "warning" | "accent" | "success" | "danger";

function chipTone(tone: Tone) {
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
  team,
  teamMessages,
  teamMessagesLoading = false,
  teamMessagesError = null,
  selectedRunId,
  runLogLoading = false,
  onBack,
  onSelectRun,
  liveLog,
  runLog,
  onPlan,
  onSendPlanFeedback,
  onSendTeamMessage,
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
          <h2>Select a task</h2>
          <p className="m-0 text-[var(--muted)]">
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

  return (
    <aside className={cn(detailPanelClass, className)}>
      {/* ── 2-col body (no top bar — everything in sidebar) ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden max-[1040px]:flex-col">
        {/* Left sidebar */}
        <div className="flex w-[280px] flex-none flex-col overflow-y-auto border-r border-border bg-[var(--bg)] max-[1040px]:w-full max-[1040px]:border-b max-[1040px]:border-r-0">
          {/* Header: back + title + badge */}
          <div className="grid gap-2 border-b border-border px-4 py-3 max-[720px]:px-3">
            <div className="flex items-center gap-2">
              {onBack ? (
                <button
                  type="button"
                  className={cn(actionBtnClass, "hover:border-border")}
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
                    task.column === "backlog" && task.lastRunId
                      ? "warning"
                      : task.column === "todo" && task.plan
                        ? "accent"
                        : columnTone(task.column)
                  )
                )}
              >
                {task.column === "backlog" && task.lastRunId
                  ? "Planning"
                  : task.column === "todo" && task.plan
                    ? "Planned"
                    : titleCase(task.column)}
              </span>
            </div>
            <h1 className="m-0 text-[0.92rem] font-semibold leading-[1.2]">
              {task.title}
            </h1>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2 max-[720px]:px-3">
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
            {canRequestReview ? (
              <button
                type="button"
                className={cn(
                  actionBtnClass,
                  "border-[rgba(73,214,196,0.28)] bg-[rgba(73,214,196,0.1)] text-[var(--accent-strong)] hover:border-[rgba(73,214,196,0.42)] hover:bg-[rgba(73,214,196,0.18)]"
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
                "ml-auto text-[var(--danger)] hover:border-[rgba(240,113,113,0.28)] hover:bg-[rgba(240,113,113,0.1)]"
              )}
              onClick={onDelete}
            >
              <TrashIcon />
            </button>
          </div>

          {/* Description */}
          <SidebarSection title="Description">
            <p className="m-0 text-[0.8rem] leading-[1.55] text-[var(--muted)]">
              {task.description || "No description provided."}
            </p>
          </SidebarSection>

          {team ? (
            <>
              <SidebarSection title="Team Context">
                <TeamCard
                  team={team}
                  workspaceName={workspace?.name}
                  compact
                />
                <div className="mt-3 grid gap-1 text-[0.72rem] text-[var(--muted)]">
                  {task.parentTaskId ? (
                    <span>Subtask thread · parent {task.parentTaskId}</span>
                  ) : (
                    <span>Coordinator thread · parent task</span>
                  )}
                  {task.teamAgentId ? (
                    <span>
                      Assigned agent ·{" "}
                      {team.agents.find((agent) => agent.id === task.teamAgentId)?.agentName ??
                        task.teamAgentId}
                    </span>
                  ) : null}
                </div>
              </SidebarSection>

              <SidebarSection title="Team Activity">
                <TeamMessageFeed
                  messages={teamMessages}
                  loading={teamMessagesLoading}
                  error={teamMessagesError}
                  onSendMessage={onSendTeamMessage}
                />
              </SidebarSection>
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

        {/* Right log pane */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface-faint)]">
          {/* Tabs */}
          <div className="flex items-center border-b border-border bg-[var(--panel)]">
            {phaseTabs.map((tab) => {
              const isActive = !showFilesTab && activePhase === tab.phase;
              const tone = runStatusTone(tab.latestRun);
              return (
                <button
                  key={tab.phase}
                  type="button"
                  className={cn(
                    "flex items-center gap-2 border-b-2 px-4 py-2.5 text-[0.75rem] transition-colors",
                    isActive
                      ? "border-[var(--accent)] text-foreground"
                      : "border-transparent text-[var(--muted)] hover:text-foreground"
                  )}
                  onClick={() => {
                    setShowFilesTab(false);
                    onSelectRun(tab.latestRun.id);
                  }}
                >
                  <span className="font-medium">{tab.label}</span>
                  <span
                    className={cn(
                      "inline-flex min-h-4 items-center rounded-none border px-1 font-mono text-[0.5rem] uppercase tracking-[0.08em]",
                      chipTone(tone)
                    )}
                  >
                    {titleCase(tab.latestRun.status)}
                  </span>
                </button>
              );
            })}

            {showWorktree ? (
              <>
                {phaseTabs.length > 0 ? (
                  <span className="mx-1 text-[rgba(140,161,160,0.3)]" aria-hidden="true">|</span>
                ) : null}
                <button
                  type="button"
                  className={cn(
                    "flex items-center gap-2 border-b-2 px-4 py-2.5 text-[0.75rem] transition-colors",
                    showFilesTab
                      ? "border-[var(--accent)] text-foreground"
                      : "border-transparent text-[var(--muted)] hover:text-foreground"
                  )}
                  onClick={() => setShowFilesTab(true)}
                >
                  <span className="font-medium">
                    {diffFiles.length > 0
                      ? `${diffFiles.length} files changed`
                      : "Files"}
                  </span>
                  {diffFiles.length > 0 ? (
                    <>
                      <span className="font-mono text-[0.58rem] text-[var(--success)]">+{diffAdditions}</span>
                      <span className="font-mono text-[0.58rem] text-[var(--danger)]">-{diffDeletions}</span>
                    </>
                  ) : null}
                </button>
              </>
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
              className="flex cursor-pointer items-start gap-2 rounded-none py-0.5 hover:text-foreground"
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
              <span className="min-w-0 break-words text-[0.76rem] leading-[1.4] text-[var(--muted)]">
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
    <div className="border-b border-border px-4 py-3 max-[720px]:px-3">
      <div className={cn(fieldLabelClass, "mb-2")}>{title}</div>
      {children}
    </div>
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
      <div className="font-mono text-[0.5rem] uppercase tracking-[0.12em] text-[var(--muted)]">
        {label}
      </div>
      <div
        className={cn(
          "min-w-0 break-words text-[0.76rem] leading-[1.4]",
          mono && "font-mono text-[0.68rem]"
        )}
      >
        {value}
      </div>
    </div>
  );
}
