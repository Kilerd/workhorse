import { CheckCircle2, Clock, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { DisplayTask } from "@/lib/task-view";

export interface PullRequestCiDisplay {
  icon: LucideIcon;
  className: string;
  label: string;
}

export function getPullRequestCiDisplay(task: DisplayTask): PullRequestCiDisplay | null {
  const checks = task.pullRequest?.statusChecks ?? task.pullRequest?.checks;
  const rollupState = task.pullRequest?.statusCheckRollupState?.toUpperCase();
  if (!checks || checks.total < 1) {
    if (rollupState === "SUCCESS") {
      return {
        icon: CheckCircle2,
        className: "text-[var(--success)]",
        label: "(0/0)"
      };
    }
    if (rollupState === "PENDING" || rollupState === "EXPECTED") {
      return {
        icon: Clock,
        className: "text-[var(--warning)]",
        label: "(0/0)"
      };
    }
    if (rollupState === "FAILURE" || rollupState === "ERROR") {
      return {
        icon: XCircle,
        className: "text-[var(--danger)]",
        label: "(0/0)"
      };
    }

    return null;
  }

  if (checks.failed > 0) {
    return {
      icon: XCircle,
      className: "text-[var(--danger)]",
      label: `(${checks.passed}/${checks.total})`
    };
  }

  if (checks.pending > 0) {
    return {
      icon: Clock,
      className: "text-[var(--warning)]",
      label: `(${checks.passed}/${checks.total})`
    };
  }

  return {
    icon: CheckCircle2,
    className: "text-[var(--success)]",
    label: `(${checks.passed}/${checks.total})`
  };
}

export type PullRequestReadiness = "pending" | "success" | "danger";

export function getPullRequestReadinessIndicator(task: DisplayTask): PullRequestReadiness {
  const pullRequest = task.pullRequest;
  if (!pullRequest) {
    return "pending";
  }

  const mergeable = pullRequest.mergeable?.toUpperCase();
  const mergeStateStatus = pullRequest.mergeStateStatus?.toUpperCase();
  const rollupState = pullRequest.statusCheckRollupState?.toUpperCase();
  const statusChecks = pullRequest.statusChecks ?? pullRequest.checks;
  const unresolvedThreads = pullRequest.unresolvedConversationCount ?? 0;

  const hasFailingChecks =
    (statusChecks?.failed ?? 0) > 0 ||
    rollupState === "FAILURE" ||
    rollupState === "ERROR";
  const hasPendingChecks =
    (statusChecks?.pending ?? 0) > 0 ||
    rollupState === "PENDING" ||
    rollupState === "EXPECTED";
  const hasConflicts = mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY";
  const needsAttention =
    unresolvedThreads > 0 ||
    hasConflicts ||
    hasFailingChecks ||
    mergeStateStatus === "BEHIND" ||
    pullRequest.reviewDecision?.toUpperCase() === "CHANGES_REQUESTED";

  if (needsAttention) {
    return "danger";
  }

  if (hasPendingChecks || mergeable === "UNKNOWN") {
    return "pending";
  }

  if (mergeable === "MERGEABLE") {
    return "success";
  }

  return "pending";
}
