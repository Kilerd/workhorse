import { titleCase } from "@/lib/format";
import type { DisplayTask } from "@/lib/task-view";
import { resolveWorkspaceAgentName } from "@/lib/coordination";
import { cn } from "@/lib/utils";
import type { Workspace, WorkspaceAgent } from "@workhorse/contracts";

import { SubtaskReviewActions } from "./SubtaskReviewActions";
import { TaskActionBar } from "./TaskActionBar";

interface Props {
  task: DisplayTask;
  workspace: Workspace | null;
  workspaceAgents: WorkspaceAgent[];
  onBack?(): void;
  onStop(): void;
  onMoveToTodo(): void;
  onMarkDone(): void;
  onArchive(): void;
  onDelete(): void;
  onApproveSubtask?(): void;
  onRejectSubtask?(reason?: string): void;
  onRetrySubtask?(): void;
  onCancelSubtask?(): void;
  reviewActionBusy?: boolean;
}

type Tone = "muted" | "info" | "warning" | "accent" | "success" | "danger";

const chipClass =
  "inline-flex min-h-7 items-center rounded-full border px-2.5 font-mono text-[0.66rem] uppercase tracking-[0.08em]";

const actionBtnClass =
  "inline-flex min-h-8 items-center gap-1.5 rounded-[var(--radius)] border border-border bg-[var(--surface-soft)] px-3 text-[0.74rem] font-[510] text-foreground transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]";

function chipTone(tone: Tone) {
  switch (tone) {
    case "info":
      return "tone-info";
    case "warning":
      return "tone-warning";
    case "accent":
      return "tone-accent";
    case "success":
      return "tone-success";
    case "danger":
      return "tone-danger";
    default:
      return "tone-muted";
  }
}

function statusForTask(task: DisplayTask): { label: string; tone: Tone } {
  if (task.cancelledAt) return { label: "Cancelled", tone: "warning" };
  if (task.rejected) return { label: "Rejected", tone: "danger" };
  if (task.column === "backlog" && task.lastRunId) {
    return { label: "Planning", tone: "warning" };
  }
  if (task.column === "todo" && task.plan) {
    return { label: "Planned", tone: "accent" };
  }
  switch (task.column) {
    case "todo":
      return { label: "Todo", tone: "info" };
    case "running":
      return { label: "Running", tone: "warning" };
    case "review":
      return { label: "Review", tone: "accent" };
    case "done":
      return { label: "Done", tone: "success" };
    case "blocked":
      return { label: "Blocked", tone: "warning" };
    default:
      return { label: titleCase(task.column), tone: "muted" };
  }
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

export function TaskDetailHeader({
  task,
  workspace,
  workspaceAgents,
  onBack,
  onStop,
  onMoveToTodo,
  onMarkDone,
  onArchive,
  onDelete,
  onApproveSubtask,
  onRejectSubtask,
  onRetrySubtask,
  onCancelSubtask,
  reviewActionBusy = false
}: Props) {
  const status = statusForTask(task);
  const isReviewableSubtask = Boolean(task.parentTaskId && task.column === "review");
  const isCancelableSubtask = Boolean(
    task.parentTaskId &&
      !task.cancelledAt &&
      task.column !== "done" &&
      task.column !== "archived"
  );
  const canApproveReviewSubtask = task.lastRunStatus === "succeeded";
  const assignedAgentName = resolveWorkspaceAgentName(task, workspaceAgents);

  return (
    <header className="grid gap-2 border-b border-border px-4 py-3 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {onBack ? (
            <button type="button" className={actionBtnClass} onClick={onBack}>
              <ArrowLeftIcon />
              <span>Back</span>
            </button>
          ) : null}
          <span className={cn(chipClass, chipTone(status.tone))}>{status.label}</span>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1.5">
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
              compact
              onStop={onStop}
              onMoveToTodo={onMoveToTodo}
              onMarkDone={onMarkDone}
              onArchive={onArchive}
            />
          )}
          <button
            type="button"
            className={cn(
              actionBtnClass,
              "tone-danger hover:border-[rgba(239,98,108,0.52)] hover:bg-[rgba(239,98,108,0.18)]"
            )}
            title="Delete task"
            onClick={() => {
              if (window.confirm(`Delete task "${task.title}"?`)) {
                onDelete();
              }
            }}
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      <h1 className="m-0 text-[1.6rem] font-[600] leading-[1.1] tracking-[-0.02em]">
        {task.title}
      </h1>

      <div className="flex flex-wrap items-center gap-2 text-[0.74rem] text-[var(--muted)]">
        {[
          workspace?.name,
          assignedAgentName,
          task.parentTaskId ? "subtask" : null
        ]
          .filter((entry): entry is string => Boolean(entry))
          .map((entry, index, parts) => (
            <span key={`${entry}-${index}`} className="inline-flex items-center gap-2">
              <span>{entry}</span>
              {index < parts.length - 1 ? (
                <span aria-hidden="true">·</span>
              ) : null}
            </span>
          ))}
      </div>
    </header>
  );
}
