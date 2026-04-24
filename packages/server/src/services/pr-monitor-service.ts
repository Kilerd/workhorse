import type {
  Run,
  RunnerConfig,
  Task,
  TaskPullRequest,
  Workspace
} from "@workhorse/contracts";

import type {
  GitHubPullRequestCheck,
  GitHubPullRequestProvider,
  GitHubPullRequestSummary
} from "../lib/github.js";
import type { StateStore } from "../persistence/state-store.js";
import type { EventBus } from "../ws/event-bus.js";
import type { GitWorktreeService } from "./git-worktree-service.js";
import {
  baseRefMatches,
  buildTaskPullRequestSummary,
  buildUnresolvedConversationSignature,
  didTimestampOccurAfter,
  extractRemoteName,
  formatMonitorFeedback,
  formatMonitorUnresolvedConversations,
  joinMonitorReasonDescriptions,
  summarizeRequiredChecks,
  summarizeTaskPullRequestChecks,
  type MonitorCiStatus,
  type MonitorReason
} from "./pull-request-snapshot.js";

export interface GitReviewMonitorResult {
  available: boolean;
  resumedTaskIds: string[];
  skippedTaskIds: string[];
}

interface StartTaskOptions {
  allowedColumns?: Task["column"][];
  runnerConfigOverride?: RunnerConfig;
  runMetadata?: Record<string, string>;
  initialInputText?: string;
  targetOrder?: number;
  targetColumn?: Task["column"];
}

export interface PrMonitorDependencies {
  store: StateStore;
  events: EventBus;
  gitWorktrees: GitWorktreeService;
  githubPullRequests: GitHubPullRequestProvider;
  startTask(taskId: string, options: StartTaskOptions): Promise<{ task: Task; run: Run }>;
  updateTask(taskId: string, input: { column?: Task["column"]; order?: number }): Promise<Task>;
  syncPullRequestSnapshot(
    taskId: string,
    next: { pullRequestUrl?: string | null; pullRequest?: TaskPullRequest | null }
  ): Promise<void>;
  isTaskActive(taskId: string): boolean;
  resolveRunnerConfig(task: Task): RunnerConfig;
  topOrder(column: Task["column"], excludingTaskId?: string): number;
}

export class PrMonitorService {
  private lastPolledAt?: string;

  constructor(private readonly deps: PrMonitorDependencies) {}

  public getLastPolledAt(): string | undefined {
    return this.lastPolledAt;
  }

  public async poll(): Promise<GitReviewMonitorResult> {
    const polledAt = new Date().toISOString();
    this.lastPolledAt = polledAt;
    this.deps.events.publish({
      type: "runtime.review-monitor.polled",
      polledAt
    });

    if (!(await this.deps.githubPullRequests.isAvailable())) {
      return {
        available: false,
        resumedTaskIds: [],
        skippedTaskIds: []
      };
    }

    const workspaces = this.deps.store.listWorkspaces();
    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const runsById = new Map(this.deps.store.listRuns().map((run) => [run.id, run]));
    const reviewTasksByWorkspace = new Map<string, Task[]>();

    for (const task of this.deps.store.listTasks()) {
      if (task.column !== "review" || this.deps.isTaskActive(task.id)) {
        continue;
      }

      const workspace = workspaceById.get(task.workspaceId);
      if (!workspace?.isGitRepo || task.worktree.status === "removed") {
        continue;
      }

      const current = reviewTasksByWorkspace.get(workspace.id) ?? [];
      current.push(task);
      reviewTasksByWorkspace.set(workspace.id, current);
    }

    const resumedTaskIds: string[] = [];
    const skippedTaskIds: string[] = [];

    for (const [workspaceId, tasks] of reviewTasksByWorkspace.entries()) {
      const workspace = workspaceById.get(workspaceId);
      if (!workspace) {
        continue;
      }

      const repositoryFullName =
        await this.deps.gitWorktrees.getGitHubRepositoryFullName(workspace);
      if (!repositoryFullName) {
        continue;
      }

      try {
        for (const remoteName of new Set(
          tasks.map((task) => extractRemoteName(task.worktree.baseRef))
        )) {
          await this.deps.gitWorktrees.fetchWorkspace(workspace, remoteName);
        }
      } catch {
        skippedTaskIds.push(...tasks.map((task) => task.id));
        continue;
      }

      for (const task of tasks) {
        try {
          const openPr = await this.deps.githubPullRequests.findOpenPullRequest(
            repositoryFullName,
            task.worktree.branchName
          );

          if (!openPr) {
            await this.deps.syncPullRequestSnapshot(task.id, {
              pullRequest: null
            });
            const mergedPr = await this.deps.githubPullRequests.findMergedPullRequest(
              repositoryFullName,
              task.worktree.branchName
            );
            if (mergedPr && baseRefMatches(task.worktree.baseRef, mergedPr.baseRef)) {
              await this.deps.updateTask(task.id, {
                column: "done",
                order: this.deps.topOrder("done", task.id)
              });
            }
            continue;
          }

          const checks = await this.deps.githubPullRequests.listRequiredChecks(
            repositoryFullName,
            openPr.number
          );
          await this.deps.syncPullRequestSnapshot(task.id, {
            pullRequestUrl: openPr.url,
            pullRequest: buildTaskPullRequestSummary(openPr, checks)
          });
          const ciStatus = summarizeRequiredChecks(checks);
          const monitorReasons = this.collectMonitorReasons(task, runsById, openPr, ciStatus);
          if (monitorReasons.length === 0) {
            continue;
          }
          if (this.wasMonitorRunAlreadyAttempted(task, runsById, openPr, ciStatus)) {
            continue;
          }

          const shouldComment = this.shouldCommentOnUnresolvedConversations(
            task,
            runsById,
            openPr
          );
          await this.deps.startTask(task.id, {
            allowedColumns: ["review"],
            runnerConfigOverride: this.buildMonitorRunnerConfig(
              task,
              openPr,
              ciStatus,
              monitorReasons
            ),
            runMetadata: this.buildMonitorRunMetadata(openPr, ciStatus, checks)
          });
          resumedTaskIds.push(task.id);
          if (shouldComment) {
            await this.postUnresolvedConversationComment(
              repositoryFullName,
              task,
              openPr
            );
          }
        } catch {
          skippedTaskIds.push(task.id);
        }
      }
    }

    return {
      available: true,
      resumedTaskIds,
      skippedTaskIds
    };
  }

  private collectMonitorReasons(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus
  ): MonitorReason[] {
    if (!baseRefMatches(task.worktree.baseRef, pullRequest.baseRef)) {
      return [];
    }

    const reasons: MonitorReason[] = [];
    const mergeable = pullRequest.mergeable?.toUpperCase();
    const mergeStateStatus = pullRequest.mergeStateStatus?.toUpperCase();
    if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
      reasons.push({
        code: "conflict",
        description: "the PR conflicts with its base branch"
      });
    } else if (mergeStateStatus === "BEHIND") {
      reasons.push({
        code: "behind",
        description: "the PR is behind its base branch"
      });
    }

    if (this.hasFailingPullRequestCi(pullRequest, ciStatus)) {
      reasons.push({
        code: "ci_failed",
        description: "the PR has failing CI checks"
      });
    }

    if (this.hasUnresolvedPullRequestConversations(task, runsById, pullRequest)) {
      reasons.push({
        code: "unresolved_conversations",
        description: "the PR has unresolved review conversations"
      });
    }

    if (this.hasNewPullRequestFeedback(task, runsById, pullRequest)) {
      reasons.push({
        code: "new_feedback",
        description: "the PR has new comments or review feedback"
      });
    }

    return reasons;
  }

  private wasMonitorRunAlreadyAttempted(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus
  ): boolean {
    if (!task.lastRunId) {
      return false;
    }

    const run = runsById.get(task.lastRunId);
    if (!run?.metadata || run.metadata.trigger !== "gh_pr_monitor") {
      return false;
    }

    if (run.status !== "succeeded") {
      return false;
    }

    return (
      run.metadata.monitorPrNumber === String(pullRequest.number) &&
      run.metadata.monitorPrHeadSha === (pullRequest.headSha ?? "") &&
      run.metadata.monitorPrBaseSha === (pullRequest.baseSha ?? "") &&
      run.metadata.monitorPrMergeState === (pullRequest.mergeStateStatus ?? "") &&
      run.metadata.monitorPrMergeable === (pullRequest.mergeable ?? "") &&
      run.metadata.monitorPrCiStatus === ciStatus &&
      run.metadata.monitorPrStatusCheckRollupState ===
        (pullRequest.statusCheckRollupState ?? "") &&
      run.metadata.monitorPrFeedbackCount === String(pullRequest.feedbackCount ?? 0) &&
      run.metadata.monitorPrFeedbackUpdatedAt === (pullRequest.feedbackUpdatedAt ?? "") &&
      run.metadata.monitorPrUnresolvedConversationCount ===
        String(pullRequest.unresolvedConversationCount ?? 0) &&
      run.metadata.monitorPrUnresolvedConversationUpdatedAt ===
        (pullRequest.unresolvedConversationUpdatedAt ?? "") &&
      run.metadata.monitorPrUnresolvedConversationSignature ===
        buildUnresolvedConversationSignature(pullRequest)
    );
  }

  private buildMonitorRunnerConfig(
    task: Task,
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus,
    reasons: MonitorReason[]
  ): RunnerConfig {
    const runnerConfig = this.deps.resolveRunnerConfig(task);
    const feedbackLines = formatMonitorFeedback(pullRequest);
    const unresolvedConversationLines = formatMonitorUnresolvedConversations(pullRequest);
    return {
      ...runnerConfig,
      prompt: [
        runnerConfig.prompt.trim(),
        "GitHub PR monitor update:",
        `- PR #${pullRequest.number} (${pullRequest.url}) needs attention because ${joinMonitorReasonDescriptions(reasons)}.`,
        `- Required CI status is currently \`${ciStatus}\`.`,
        pullRequest.statusCheckRollupState
          ? `- Overall PR check rollup is \`${pullRequest.statusCheckRollupState}\`.`
          : undefined,
        pullRequest.reviewDecision
          ? `- Review decision is \`${pullRequest.reviewDecision}\`.`
          : undefined,
        feedbackLines.length > 0 ? "- Recent PR feedback to address:" : undefined,
        ...feedbackLines.map((line) => `  - ${line}`),
        unresolvedConversationLines.length > 0
          ? "- Unresolved review conversations to address:"
          : undefined,
        ...unresolvedConversationLines.map((line) => `  - ${line}`),
        `- Continue from the existing branch \`${task.worktree.branchName}\`.`,
        `- Fetch the latest \`${task.worktree.baseRef}\`, rebase onto it, resolve any conflicts, rerun the smallest useful verification, and push the updated branch.`,
        unresolvedConversationLines.length > 0
          ? "- Resolve each remaining review conversation on GitHub, or explicitly explain in a PR comment why a conversation should stay unresolved."
          : undefined,
        "- Keep the PR up to date and mention the PR URL in your final response."
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n\n")
    };
  }

  private buildMonitorRunMetadata(
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus,
    checks: GitHubPullRequestCheck[]
  ): Record<string, string> {
    const checkSummary = summarizeTaskPullRequestChecks(checks);

    return {
      trigger: "gh_pr_monitor",
      monitorPrNumber: String(pullRequest.number),
      monitorPrUrl: pullRequest.url,
      monitorPrHeadRef: pullRequest.headRef,
      monitorPrBaseRef: pullRequest.baseRef,
      monitorPrHeadSha: pullRequest.headSha ?? "",
      monitorPrBaseSha: pullRequest.baseSha ?? "",
      monitorPrMergeState: pullRequest.mergeStateStatus ?? "",
      monitorPrMergeable: pullRequest.mergeable ?? "",
      monitorPrCiStatus: ciStatus,
      monitorPrStatusCheckRollupState: pullRequest.statusCheckRollupState ?? "",
      monitorPrFeedbackCount: String(pullRequest.feedbackCount ?? 0),
      monitorPrFeedbackUpdatedAt: pullRequest.feedbackUpdatedAt ?? "",
      monitorPrUnresolvedConversationCount: String(
        pullRequest.unresolvedConversationCount ?? 0
      ),
      monitorPrUnresolvedConversationUpdatedAt:
        pullRequest.unresolvedConversationUpdatedAt ?? "",
      monitorPrUnresolvedConversationSignature:
        buildUnresolvedConversationSignature(pullRequest),
      monitorPrReviewDecision: pullRequest.reviewDecision ?? "",
      monitorPrRequiredChecksTotal: String(checkSummary?.total ?? 0),
      monitorPrRequiredChecksPassed: String(checkSummary?.passed ?? 0),
      monitorPrRequiredChecksFailed: String(checkSummary?.failed ?? 0),
      monitorPrRequiredChecksPending: String(checkSummary?.pending ?? 0)
    };
  }

  private hasFailingPullRequestCi(
    pullRequest: GitHubPullRequestSummary,
    ciStatus: MonitorCiStatus
  ): boolean {
    if (ciStatus === "fail" || ciStatus === "cancel") {
      return true;
    }

    const rollupState = pullRequest.statusCheckRollupState?.toUpperCase();
    return (
      rollupState === "FAILURE" ||
      rollupState === "ERROR" ||
      rollupState === "CANCELLED" ||
      rollupState === "TIMED_OUT"
    );
  }

  private hasNewPullRequestFeedback(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary
  ): boolean {
    const feedbackUpdatedAt = pullRequest.feedbackUpdatedAt?.trim();
    const feedbackCount = pullRequest.feedbackCount ?? 0;
    if (!feedbackUpdatedAt || feedbackCount === 0) {
      return false;
    }

    if (!task.lastRunId) {
      return true;
    }

    const run = runsById.get(task.lastRunId);
    if (!run) {
      return true;
    }

    if (run.metadata?.trigger === "gh_pr_monitor") {
      return (
        run.metadata.monitorPrFeedbackCount !== String(feedbackCount) ||
        run.metadata.monitorPrFeedbackUpdatedAt !== feedbackUpdatedAt
      );
    }

    return didTimestampOccurAfter(run.endedAt ?? run.startedAt, feedbackUpdatedAt);
  }

  private hasUnresolvedPullRequestConversations(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary
  ): boolean {
    if ((pullRequest.unresolvedConversationCount ?? 0) === 0) {
      return false;
    }

    const unresolvedConversationSignature =
      buildUnresolvedConversationSignature(pullRequest);
    if (!unresolvedConversationSignature) {
      return false;
    }

    if (!task.lastRunId) {
      return true;
    }

    const run = runsById.get(task.lastRunId);
    if (!run) {
      return true;
    }

    if (run.metadata?.trigger !== "gh_pr_monitor") {
      return true;
    }

    return (
      run.metadata.monitorPrUnresolvedConversationSignature !==
      unresolvedConversationSignature
    );
  }

  private shouldCommentOnUnresolvedConversations(
    task: Task,
    runsById: Map<string, Run>,
    pullRequest: GitHubPullRequestSummary
  ): boolean {
    if ((pullRequest.unresolvedConversationCount ?? 0) === 0) {
      return false;
    }

    const unresolvedConversationSignature =
      buildUnresolvedConversationSignature(pullRequest);
    if (!unresolvedConversationSignature) {
      return false;
    }

    const run = task.lastRunId ? runsById.get(task.lastRunId) : undefined;
    return (
      run?.metadata?.monitorPrUnresolvedConversationSignature !==
      unresolvedConversationSignature
    );
  }

  private async postUnresolvedConversationComment(
    repositoryFullName: string,
    task: Task,
    pullRequest: GitHubPullRequestSummary
  ): Promise<void> {
    const count = pullRequest.unresolvedConversationCount ?? 0;
    if (count === 0) {
      return;
    }

    const conversationLabel = count === 1 ? "conversation" : "conversations";
    const summaryLines = formatMonitorUnresolvedConversations(pullRequest)
      .slice(0, 3)
      .map((line) => `- ${line}`);
    const body = [
      `Detected ${count} unresolved review ${conversationLabel} while this PR was in review, so I'm moving task \`${task.title}\` back to running to address them.`,
      summaryLines.length > 0 ? summaryLines.join("\n") : undefined,
      "If you want me to leave any of these conversations unresolved instead of changing the code, reply here and say which ones should stay open."
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");

    try {
      await this.deps.githubPullRequests.addPullRequestComment(
        repositoryFullName,
        pullRequest.number,
        body
      );
    } catch {
      // Best effort: the task should still resume even if the PR comment fails.
    }
  }
}
