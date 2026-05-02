import type { ReactNode } from "react";
import type { Workspace, WorkspaceAgent } from "@workhorse/contracts";

import { formatCount, titleCase } from "@/lib/format";
import { resolveWorkspaceAgentName } from "@/lib/coordination";
import { renderMarkdownBlock } from "@/lib/markdown";
import type { DisplayTask } from "@/lib/task-view";
import { cn } from "@/lib/utils";

import { DependencyPicker } from "../DependencyPicker";

interface Props {
  task: DisplayTask;
  allTasks: DisplayTask[];
  workspace: Workspace | null;
  workspaceAgents: WorkspaceAgent[];
  onSetDependencies(ids: string[]): void;
  onCleanupWorktree(): void;
}

const fieldLabelClass = "section-kicker m-0 text-[0.66rem]";
const cardClass = "surface-card grid gap-3 px-4 py-4";

const actionBtnClass =
  "inline-flex min-h-8 items-center gap-1.5 rounded-[var(--radius)] border border-border bg-[var(--surface-soft)] px-3 text-[0.74rem] font-[510] text-foreground transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={cardClass}>
      <div className={cn(fieldLabelClass, "mb-1")}>{title}</div>
      {children}
    </section>
  );
}

function Field({
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
          "min-w-0 break-words text-[0.86rem] leading-[1.55]",
          mono && "font-mono text-[0.74rem]"
        )}
      >
        {value}
      </div>
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
  const count = pr?.changedFiles !== undefined ? pr.changedFiles : pr?.files?.length;
  return count === undefined ? "Sync pending" : formatCount(count, "file");
}

export function OverviewTab({
  task,
  allTasks,
  workspace,
  workspaceAgents,
  onSetDependencies,
  onCleanupWorktree
}: Props) {
  const showWorktree = workspace?.isGitRepo ?? false;
  const canCleanupWorktree =
    showWorktree &&
    (task.worktree.status === "ready" || task.worktree.status === "cleanup_pending");
  const pullRequest = task.pullRequest;
  const showPullRequest = Boolean(task.pullRequestUrl || pullRequest);
  const pullRequestFiles = pullRequest?.files ?? [];
  const changedFiles =
    pullRequest?.changedFiles !== undefined ? pullRequest.changedFiles : pullRequest?.files?.length;
  const assignedAgentName = resolveWorkspaceAgentName(task, workspaceAgents);

  const candidateCount = allTasks.filter(
    (t) => t.id !== task.id && t.workspaceId === task.workspaceId && t.column !== "archived"
  ).length;

  return (
    <div className="mx-auto grid max-w-[64rem] content-start gap-4 px-4 py-4 sm:px-5">
      <Card title="Description">
        {task.description?.trim()
          ? renderMarkdownBlock(task.description)
          : (
            <p className="m-0 text-[0.92rem] text-[var(--muted)]">
              No description provided.
            </p>
          )}
      </Card>

      {task.parentTaskId ? (
        <Card title="Subtask">
          <div className="grid gap-1 text-[0.78rem] text-[var(--muted)]">
            <span>Parent · {task.parentTaskId}</span>
            {assignedAgentName ? <span>Agent · {assignedAgentName}</span> : null}
            {task.rejected ? <span>Decision · rejected</span> : null}
          </div>
        </Card>
      ) : null}

      {candidateCount > 0 ? (
        <Card title="Dependencies">
          <DependencyPicker
            task={task}
            allTasks={allTasks}
            onSetDependencies={onSetDependencies}
          />
        </Card>
      ) : null}

      {showWorktree ? (
        <Card title="Worktree">
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
            <Field label="Status" value={titleCase(task.worktree.status)} />
            <Field label="Base ref" value={task.worktree.baseRef || "none"} mono />
            <Field
              label="Branch"
              value={task.worktree.branchName}
              mono
              className="col-span-2"
            />
            {task.worktree.path ? (
              <Field
                label="Path"
                value={task.worktree.path}
                mono
                className="col-span-2 sm:col-span-4"
              />
            ) : null}
          </div>
          {canCleanupWorktree ? (
            <button
              type="button"
              className={cn(actionBtnClass, "justify-self-start")}
              onClick={onCleanupWorktree}
            >
              {task.worktree.status === "cleanup_pending"
                ? "Retry cleanup"
                : "Remove worktree"}
            </button>
          ) : null}
        </Card>
      ) : null}

      {showPullRequest ? (
        <Card title="Pull request">
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-5">
            <Field
              label="Number"
              value={pullRequest?.number !== undefined ? `#${pullRequest.number}` : "-"}
              mono
            />
            <Field
              label="Merge"
              value={formatPrState(pullRequest?.mergeStateStatus ?? pullRequest?.mergeable)}
            />
            <Field label="Review" value={formatPrState(pullRequest?.reviewDecision)} />
            <Field label="Checks" value={formatPrChecksSummary(pullRequest)} />
            <Field label="Files" value={formatPrFilesSummary(pullRequest)} />
          </div>

          {task.pullRequestUrl ? (
            <a
              className="block truncate font-mono text-[0.7rem] text-[var(--accent)] no-underline hover:underline"
              href={task.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
            >
              {task.pullRequestUrl}
            </a>
          ) : null}

          {pullRequestFiles.length > 0 ? (
            <div className="grid border border-border bg-[var(--surface-soft)]">
              {pullRequestFiles.slice(0, 10).map((file) => (
                <div
                  className="flex items-start justify-between gap-2 border-b border-border px-2 py-1.5 last:border-b-0"
                  key={file.path}
                >
                  <code className="min-w-0 break-all font-mono text-[0.62rem] leading-[1.5]">
                    {file.path}
                  </code>
                  <div className="flex shrink-0 items-center gap-1.5 font-mono text-[0.6rem]">
                    <span className="text-[var(--success)]">+{file.additions ?? 0}</span>
                    <span className="text-[var(--danger)]">-{file.deletions ?? 0}</span>
                  </div>
                </div>
              ))}
              {changedFiles !== undefined && changedFiles > 10 ? (
                <div className="px-2 py-1.5 text-[0.62rem] text-[var(--muted)]">
                  +{changedFiles - 10} more
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
