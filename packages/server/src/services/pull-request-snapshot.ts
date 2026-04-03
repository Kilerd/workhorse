import type {
  Run,
  Task,
  TaskPullRequest,
  TaskPullRequestChecks,
  TaskPullRequestFile
} from "@workhorse/contracts";

import type {
  GitHubCheckBucket,
  GitHubPullRequestCheck,
  GitHubPullRequestFile,
  GitHubPullRequestSummary
} from "../lib/github.js";

export type MonitorCiStatus = GitHubCheckBucket | "not_required";

export type MonitorReasonCode =
  | "behind"
  | "conflict"
  | "ci_failed"
  | "new_feedback"
  | "unresolved_conversations";

export interface MonitorReason {
  code: MonitorReasonCode;
  description: string;
}

export function toOptionalNumber(value?: string): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildTaskPullRequestSummary(
  pullRequest: GitHubPullRequestSummary,
  checks: GitHubPullRequestCheck[]
): TaskPullRequest {
  const summary: TaskPullRequest = {
    number: pullRequest.number,
    changedFiles: pullRequest.changedFiles,
    mergeable: pullRequest.mergeable,
    mergeStateStatus: pullRequest.mergeStateStatus,
    reviewDecision: pullRequest.reviewDecision,
    statusCheckRollupState: pullRequest.statusCheckRollupState,
    unresolvedConversationCount: pullRequest.unresolvedConversationCount,
    checks: summarizeTaskPullRequestChecks(checks),
    statusChecks: pullRequest.statusChecks,
    files: mapTaskPullRequestFiles(pullRequest.files)
  };

  if (pullRequest.title) {
    summary.title = pullRequest.title;
  }
  if (pullRequest.state) {
    summary.state = pullRequest.state;
  }
  if (pullRequest.isDraft !== undefined) {
    summary.isDraft = pullRequest.isDraft;
  }
  if (pullRequest.threadCount !== undefined) {
    summary.threadCount = pullRequest.threadCount;
  }
  if (pullRequest.reviewCount !== undefined) {
    summary.reviewCount = pullRequest.reviewCount;
  }
  if (pullRequest.approvalCount !== undefined) {
    summary.approvalCount = pullRequest.approvalCount;
  }
  if (pullRequest.changesRequestedCount !== undefined) {
    summary.changesRequestedCount = pullRequest.changesRequestedCount;
  }

  return summary;
}

export function summarizeTaskPullRequestChecks(
  checks: GitHubPullRequestCheck[]
): TaskPullRequestChecks | undefined {
  if (checks.length === 0) {
    return undefined;
  }

  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const check of checks) {
    if (check.bucket === "pass") {
      passed += 1;
      continue;
    }

    if (check.bucket === "fail" || check.bucket === "cancel") {
      failed += 1;
      continue;
    }

    if (check.bucket === "pending" || check.bucket === "skipping") {
      pending += 1;
    }
  }

  return {
    total: checks.length,
    passed,
    failed,
    pending
  };
}

export function mapTaskPullRequestFiles(
  files?: GitHubPullRequestFile[]
): TaskPullRequestFile[] | undefined {
  if (!files?.length) {
    return undefined;
  }

  return files.map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions
  }));
}

export function taskPullRequestEquals(
  left?: TaskPullRequest,
  right?: TaskPullRequest
): boolean {
  if (left === right) {
    return true;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildUnresolvedConversationSignature(
  pullRequest: GitHubPullRequestSummary
): string {
  const ids = (pullRequest.unresolvedConversationItems ?? [])
    .map((item) => item.id.trim())
    .filter((value) => value.length > 0)
    .sort();
  if (ids.length === 0) {
    return "";
  }

  return [
    String(pullRequest.unresolvedConversationCount ?? ids.length),
    pullRequest.unresolvedConversationUpdatedAt ?? "",
    ids.join(",")
  ].join("|");
}

export function resolveTaskPullRequestUrl(task: Task, run: Run): string | undefined {
  const latestPullRequestUrl = run.metadata?.prUrl?.trim();
  if (latestPullRequestUrl) {
    return latestPullRequestUrl;
  }

  const monitoredPullRequestUrl = run.metadata?.monitorPrUrl?.trim();
  if (monitoredPullRequestUrl) {
    return monitoredPullRequestUrl;
  }

  const existingPullRequestUrl = task.pullRequestUrl?.trim();
  return existingPullRequestUrl || undefined;
}

export function resolveTaskPullRequestSummary(
  task: Task,
  run: Run
): TaskPullRequest | undefined {
  const metadata = run.metadata;
  if (!metadata) {
    return task.pullRequest;
  }

  const number = toOptionalNumber(metadata.monitorPrNumber);
  const checksTotal = toOptionalNumber(metadata.monitorPrRequiredChecksTotal);
  const checksPassed = toOptionalNumber(metadata.monitorPrRequiredChecksPassed);
  const checksFailed = toOptionalNumber(metadata.monitorPrRequiredChecksFailed);
  const checksPending = toOptionalNumber(metadata.monitorPrRequiredChecksPending);
  const unresolvedConversationCount = toOptionalNumber(
    metadata.monitorPrUnresolvedConversationCount
  );
  const hasMonitorData =
    number !== undefined ||
    Boolean(metadata.monitorPrMergeable) ||
    Boolean(metadata.monitorPrMergeState) ||
    Boolean(metadata.monitorPrStatusCheckRollupState) ||
    Boolean(metadata.monitorPrReviewDecision) ||
    unresolvedConversationCount !== undefined ||
    checksTotal !== undefined;

  if (!hasMonitorData) {
    return task.pullRequest;
  }

  const checks =
    checksTotal !== undefined && checksTotal > 0
      ? {
          total: checksTotal,
          passed: checksPassed ?? 0,
          failed: checksFailed ?? 0,
          pending: checksPending ?? 0
        }
      : undefined;

  const summary: TaskPullRequest = {
    number,
    mergeable: metadata.monitorPrMergeable || undefined,
    mergeStateStatus: metadata.monitorPrMergeState || undefined,
    reviewDecision: metadata.monitorPrReviewDecision || undefined,
    statusCheckRollupState: metadata.monitorPrStatusCheckRollupState || undefined,
    unresolvedConversationCount,
    checks
  };

  if (task.pullRequest?.title) {
    summary.title = task.pullRequest.title;
  }
  if (task.pullRequest?.state) {
    summary.state = task.pullRequest.state;
  }
  if (task.pullRequest?.isDraft !== undefined) {
    summary.isDraft = task.pullRequest.isDraft;
  }
  if (task.pullRequest?.changedFiles !== undefined) {
    summary.changedFiles = task.pullRequest.changedFiles;
  }
  if (task.pullRequest?.threadCount !== undefined) {
    summary.threadCount = task.pullRequest.threadCount;
  }
  if (task.pullRequest?.reviewCount !== undefined) {
    summary.reviewCount = task.pullRequest.reviewCount;
  }
  if (task.pullRequest?.approvalCount !== undefined) {
    summary.approvalCount = task.pullRequest.approvalCount;
  }
  if (task.pullRequest?.changesRequestedCount !== undefined) {
    summary.changesRequestedCount = task.pullRequest.changesRequestedCount;
  }
  if (task.pullRequest?.files) {
    summary.files = task.pullRequest.files;
  }
  if (task.pullRequest?.statusChecks) {
    summary.statusChecks = task.pullRequest.statusChecks;
  }

  return summary;
}

export function summarizeRequiredChecks(
  checks: { bucket: GitHubCheckBucket }[]
): MonitorCiStatus {
  if (checks.length === 0) {
    return "not_required";
  }

  if (checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")) {
    return "fail";
  }
  if (checks.some((check) => check.bucket === "pending")) {
    return "pending";
  }
  if (checks.some((check) => check.bucket === "pass")) {
    return "pass";
  }
  if (checks.some((check) => check.bucket === "skipping")) {
    return "skipping";
  }

  return "not_required";
}

export function baseRefMatches(baseRef: string, branchName: string): boolean {
  const trimmed = baseRef.trim();
  return trimmed === branchName || trimmed.endsWith(`/${branchName}`);
}

export function extractRemoteName(baseRef: string): string {
  const trimmed = baseRef.trim();
  if (!trimmed.includes("/")) {
    return "origin";
  }

  const [remoteName] = trimmed.split("/", 1);
  return remoteName || "origin";
}

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function summarizeMonitorFeedbackBody(body?: string): string {
  const normalized = body?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No text included.";
  }

  if (normalized.length <= 160) {
    return normalized;
  }

  return `${normalized.slice(0, 157)}...`;
}

export function didTimestampOccurAfter(
  referenceTime?: string,
  candidateTime?: string
): boolean {
  const referenceMs = referenceTime ? Date.parse(referenceTime) : Number.NaN;
  const candidateMs = candidateTime ? Date.parse(candidateTime) : Number.NaN;
  if (!Number.isFinite(candidateMs)) {
    return false;
  }
  if (!Number.isFinite(referenceMs)) {
    return true;
  }

  return candidateMs > referenceMs;
}

export function joinMonitorReasonDescriptions(reasons: MonitorReason[]): string {
  const descriptions = reasons.map((reason) => reason.description);
  if (descriptions.length === 0) {
    return "the PR needs attention";
  }
  if (descriptions.length === 1) {
    return descriptions[0]!;
  }
  if (descriptions.length === 2) {
    return `${descriptions[0]} and ${descriptions[1]}`;
  }

  return `${descriptions.slice(0, -1).join(", ")}, and ${descriptions.at(-1)}`;
}

export function formatMonitorFeedback(pullRequest: GitHubPullRequestSummary): string[] {
  return (pullRequest.feedbackItems ?? [])
    .slice(0, 5)
    .map((item) => {
      const author = item.author ? `@${item.author}` : "someone";
      const state = item.source === "review" && item.state ? ` (${item.state})` : "";
      const body = summarizeMonitorFeedbackBody(item.body);
      const when = item.updatedAt ?? item.createdAt;
      return `${author}${state}${when ? ` at ${when}` : ""}: ${body}`;
    });
}

export function formatMonitorUnresolvedConversations(
  pullRequest: GitHubPullRequestSummary
): string[] {
  return (pullRequest.unresolvedConversationItems ?? [])
    .slice(0, 5)
    .map((item) => {
      const author = item.author ? `@${item.author}` : "someone";
      const location = item.path
        ? `${item.path}${item.line ? `:${item.line}` : ""}`
        : "the PR diff";
      const outdated = item.isOutdated ? " [outdated]" : "";
      const when = item.updatedAt ?? item.createdAt;
      return `${author}${when ? ` at ${when}` : ""} in ${location}${outdated}: ${summarizeMonitorFeedbackBody(item.body)}`;
    });
}
