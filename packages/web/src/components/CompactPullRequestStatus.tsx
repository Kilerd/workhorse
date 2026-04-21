import type { CSSProperties } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  GitMerge,
  GitPullRequest,
  MessageSquare
} from "lucide-react";

import { getPullRequestCiDisplay, getPullRequestReadinessIndicator } from "@/lib/pull-request-display";
import type { DisplayTask } from "@/lib/task-view";
import { cn } from "@/lib/utils";

interface ReviewCountdown {
  label: string;
  progress: number;
}

const compactPrRowClass = "flex min-w-0 flex-wrap items-center gap-1.5";
const compactBadgeClass =
  "inline-flex min-h-7 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em]";
const compactStatClass = "inline-flex items-center gap-1 font-mono text-[0.7rem]";

export function CompactPullRequestStatus({
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
    <div className="grid min-w-0 gap-1.5">
      <div className={compactPrRowClass}>
        <a
          href={task.pullRequestUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            "inline-flex items-center gap-1 font-mono text-[0.625rem] no-underline hover:underline",
            isMerged && "text-[var(--accent-strong)]",
            isClosed && "text-[var(--muted)]",
            !isMerged && !isClosed && "text-[var(--success)]"
          )}
        >
          <PullRequestIcon className="size-3 shrink-0" />
          {pullRequest.number !== undefined ? `#${pullRequest.number}` : "PR"}
        </a>

        {pullRequest.isDraft ? (
          <span className={cn(compactBadgeClass, "text-[var(--muted)]")}>DRAFT</span>
        ) : null}

        {hasConflicts ? (
          <span
            className={cn(
              compactBadgeClass,
              "border-[rgba(181,74,74,0.26)] bg-[rgba(181,74,74,0.08)] text-[var(--danger)]"
            )}
          >
            <AlertTriangle className="size-2.5 shrink-0" />
            CONFLICTS
          </span>
        ) : null}

        {ciDisplay ? (
          <span className={cn(compactStatClass, ciDisplay.className)}>
            <ciDisplay.icon className="size-3 shrink-0" />
            <span>{ciDisplay.label}</span>
          </span>
        ) : null}

        {isApproved ? (
          <span
            className={cn(
              compactBadgeClass,
              "border-[rgba(47,117,88,0.26)] bg-[rgba(47,117,88,0.08)] text-[var(--success)]"
            )}
          >
            APPROVED
          </span>
        ) : null}
        {changesRequested ? (
          <span
            className={cn(
              compactBadgeClass,
              "border-[rgba(166,109,26,0.24)] bg-[rgba(166,109,26,0.08)] text-[var(--warning)]"
            )}
          >
            CHANGES
          </span>
        ) : null}

        {threadCount > 0 ? (
          <span
            className={cn(
              compactStatClass,
              unresolvedThreads > 0 ? "text-[var(--warning)]" : "text-[var(--muted)]"
            )}
          >
            <MessageSquare className="size-3 shrink-0" />
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
        className="inline-flex min-w-0 items-center gap-1 overflow-hidden text-[0.6875rem] leading-[1.3] text-[var(--muted)] no-underline hover:underline"
        title={pullRequest.title ?? task.pullRequestUrl}
      >
        <span
          className={cn(
            "inline-flex size-[11px] shrink-0 items-center justify-center",
            readiness === "success" && "text-[var(--success)]",
            readiness === "danger" && "text-[var(--danger)]",
            readiness === "pending" &&
              "rounded-full border border-[rgba(113,112,255,0.24)] bg-[radial-gradient(circle_at_center,var(--panel)_56%,transparent_60%),conic-gradient(var(--accent-strong)_var(--review-progress),rgba(113,112,255,0.14)_0)]"
          )}
          aria-label={reviewIndicatorTitle}
          title={reviewIndicatorTitle}
          style={
            readiness === "pending" && reviewCountdown
              ? ({
                  "--review-progress": `${reviewCountdown.progress}turn`,
                  transform: "rotate(-90deg)"
                } as CSSProperties)
              : undefined
          }
        >
          {readiness === "success" ? (
            <CheckCircle2 className="size-[11px] shrink-0" />
          ) : null}
          {readiness === "danger" ? (
            <AlertTriangle className="size-[11px] shrink-0" />
          ) : null}
        </span>
        <span className="min-w-0 truncate">{pullRequest.title ?? task.pullRequestUrl}</span>
      </a>
    </div>
  );
}
