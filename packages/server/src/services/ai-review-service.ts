import type {
  GlobalSettings,
  Run,
  RunLogEntry,
  RunnerConfig,
  Task,
  Workspace
} from "@workhorse/contracts";
import {
  resolveTemplate,
  resolveWorkspacePromptTemplate
} from "@workhorse/contracts";

import type { GitHubPullRequestProvider, GitHubPullRequestReviewAction } from "../lib/github.js";
import { createRunLogEntry } from "../lib/run-log.js";
import { stripStructuredReviewBlocks } from "../lib/review-parser.js";
import type { StateStore } from "../persistence/state-store.js";
import type { EventBus } from "../ws/event-bus.js";
import type { GitWorktreeService } from "./git-worktree-service.js";

function formatOptionalLine(
  value: string | undefined,
  format: (resolvedValue: string) => string
): string {
  const resolvedValue = value?.trim();
  return resolvedValue ? format(resolvedValue) : "";
}

interface StartTaskOptions {
  allowedColumns?: Task["column"][];
  runnerConfigOverride?: RunnerConfig;
  runMetadata?: Record<string, string>;
  initialInputText?: string;
  targetOrder?: number;
  targetColumn?: Task["column"];
}

export interface AiReviewDependencies {
  store: StateStore;
  events: EventBus;
  gitWorktrees: GitWorktreeService;
  githubPullRequests: GitHubPullRequestProvider;
  startTask(taskId: string, options: StartTaskOptions): Promise<{ task: Task; run: Run }>;
  appendAndPublishRunOutput(taskId: string, runId: string, entry: RunLogEntry): Promise<void>;
  updateRunMetadata(runId: string, metadata: Record<string, string>): Promise<Run>;
  refreshPullRequestSnapshot(task: Task, workspace: Workspace): Promise<Task>;
  getSettings(): GlobalSettings;
  topOrder(column: Task["column"], excludingTaskId?: string): number;
}

export class AiReviewService {
  constructor(private readonly deps: AiReviewDependencies) {}

  public isAiReviewTrigger(trigger?: string): boolean {
    return trigger === "manual_claude_review" || trigger === "auto_ai_review";
  }

  public shouldAutoTriggerAiReview(
    task: Task,
    run: Run,
    status: Run["status"]
  ): boolean {
    if (status !== "succeeded") {
      return false;
    }

    if (task.runnerType === "shell") {
      return false;
    }

    if (this.isAiReviewTrigger(run.metadata?.trigger)) {
      return false;
    }

    if (run.metadata?.trigger === "gh_pr_monitor") {
      return false;
    }

    const workspace = this.deps.store
      .listWorkspaces()
      .find((entry) => entry.id === task.workspaceId);
    return Boolean(workspace?.isGitRepo);
  }

  public async triggerAiReview(task: Task): Promise<void> {
    try {
      const workspace = this.deps.store
        .listWorkspaces()
        .find((entry) => entry.id === task.workspaceId);
      if (!workspace) {
        return;
      }

      const refreshedTask = await this.deps.refreshPullRequestSnapshot(
        task,
        workspace
      );
      await this.deps.startTask(refreshedTask.id, {
        allowedColumns: ["running"],
        targetColumn: "running",
        runnerConfigOverride: this.buildManualReviewRunnerConfig(refreshedTask),
        runMetadata: {
          ...this.buildManualReviewRunMetadata(refreshedTask),
          trigger: "auto_ai_review"
        }
      });
    } catch {
      await this.moveTaskToColumnOnFailure(task.id, "review");
    }
  }

  public async triggerReworkFromReview(task: Task, reviewRun: Run): Promise<void> {
    try {
      const workspace = this.deps.store
        .listWorkspaces()
        .find((entry) => entry.id === task.workspaceId);
      const summary = reviewRun.metadata?.reviewSummary?.trim();
      const reworkPrompt = resolveTemplate(
        resolveWorkspacePromptTemplate("reviewFollowUp", workspace?.promptTemplates),
        {
          taskTitle: task.title,
          reviewSummary: summary ?? "",
          reviewRunId: reviewRun.id,
          reviewFollowUpInstruction: summary
            ? `Address the following feedback:\n\n${summary}`
            : "Review the latest review log and address the issues found."
        }
      );
      await this.deps.startTask(task.id, {
        allowedColumns: ["running"],
        initialInputText: reworkPrompt,
        runMetadata: {
          trigger: "ai_review_rework",
          reviewRunId: reviewRun.id
        }
      });
    } catch {
      await this.moveTaskToColumnOnFailure(task.id, "review");
    }
  }

  public async maybePublishManualReviewToPullRequest(
    task: Task,
    run: Run
  ): Promise<void> {
    if (!this.isAiReviewTrigger(run.metadata?.trigger)) {
      return;
    }

    if (run.status !== "succeeded" || run.metadata?.reviewPublishedAt?.trim()) {
      return;
    }

    const workspace = this.deps.store
      .listWorkspaces()
      .find((entry) => entry.id === task.workspaceId);
    if (!workspace?.isGitRepo) {
      return;
    }

    if (!(await this.deps.githubPullRequests.isAvailable())) {
      await this.appendReviewPublicationLog(
        task.id,
        run.id,
        "GitHub review publish skipped",
        "GitHub CLI auth is unavailable, so the Claude review was not posted back to the PR.\n"
      );
      return;
    }

    const repositoryFullName =
      (await this.deps.gitWorktrees.getGitHubRepositoryFullName(workspace)) ??
      this.extractRepositoryFullNameFromPullRequestUrl(task.pullRequestUrl);
    const pullRequestTarget =
      task.pullRequest?.number ?? task.pullRequestUrl?.trim() ?? "";
    if (!repositoryFullName || !pullRequestTarget) {
      return;
    }

    const reviewBody = await this.buildPullRequestReviewBody(task, run);
    if (!reviewBody) {
      await this.appendReviewPublicationLog(
        task.id,
        run.id,
        "GitHub review publish skipped",
        "Claude finished the review run, but there was no publishable review body to send to GitHub.\n"
      );
      return;
    }

    let publishedAction = this.resolveGitHubReviewAction(run.metadata?.reviewVerdict);

    try {
      try {
        await this.deps.githubPullRequests.submitPullRequestReview(
          repositoryFullName,
          pullRequestTarget,
          publishedAction,
          reviewBody
        );
      } catch (submitError) {
        if (publishedAction !== "comment" && this.isSelfReviewError(submitError)) {
          const previousAction = publishedAction;
          publishedAction = "comment";
          await this.appendReviewPublicationLog(
            task.id,
            run.id,
            "GitHub review downgraded to comment",
            `Cannot ${previousAction === "approve" ? "approve" : "request changes on"} own PR; retrying as comment review.\n`
          );
          await this.deps.githubPullRequests.submitPullRequestReview(
            repositoryFullName,
            pullRequestTarget,
            publishedAction,
            reviewBody
          );
        } else {
          throw submitError;
        }
      }
      await this.deps.updateRunMetadata(run.id, {
        reviewPublishedAt: new Date().toISOString(),
        reviewPublicationMethod: "gh_pr_review",
        reviewPublishedAction: publishedAction,
        reviewPublishedTarget:
          typeof pullRequestTarget === "number"
            ? String(pullRequestTarget)
            : pullRequestTarget
      });
      await this.appendReviewPublicationLog(
        task.id,
        run.id,
        "GitHub review published",
        `Submitted a ${this.formatGitHubReviewAction(publishedAction)} review to ${task.pullRequestUrl ?? `PR ${String(pullRequestTarget)}`}.\n`
      );
      await this.deps.refreshPullRequestSnapshot(task, workspace);
    } catch (error) {
      await this.appendReviewPublicationLog(
        task.id,
        run.id,
        "GitHub review publish failed",
        `${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  public buildManualReviewRunnerConfig(task: Task): RunnerConfig {
    const workspace = this.deps.store
      .listWorkspaces()
      .find((entry) => entry.id === task.workspaceId);
    const language = this.deps.getSettings().language.trim() || "English";
    const pullRequest = task.pullRequest;
    const changedFiles = (pullRequest?.files ?? [])
      .slice(0, 20)
      .map((file) => {
        const stats =
          file.additions !== undefined || file.deletions !== undefined
            ? ` (+${file.additions ?? 0}/-${file.deletions ?? 0})`
            : "";
        return `- ${file.path}${stats}`;
      });

    const description = task.description.trim();
    const prompt = resolveTemplate(
      resolveWorkspacePromptTemplate("review", workspace?.promptTemplates),
      {
        taskTitle: task.title,
        taskDescription: description,
        taskDescriptionBlock: description
          ? `Task description:\n${description}`
          : "",
        baseRef: task.worktree.baseRef,
        branchName: task.worktree.branchName,
        pullRequestUrl: task.pullRequestUrl ?? "",
        pullRequestUrlLine: formatOptionalLine(task.pullRequestUrl, (value) => `GitHub PR: ${value}`),
        pullRequestTitle: pullRequest?.title ?? "",
        pullRequestTitleLine: formatOptionalLine(pullRequest?.title, (value) => `PR title: ${value}`),
        pullRequestReviewDecision: pullRequest?.reviewDecision ?? "",
        pullRequestReviewDecisionLine: formatOptionalLine(
          pullRequest?.reviewDecision,
          (value) => `Current GitHub review decision: ${value}`
        ),
        pullRequestStatusRollup: pullRequest?.statusCheckRollupState ?? "",
        pullRequestStatusRollupLine: formatOptionalLine(
          pullRequest?.statusCheckRollupState,
          (value) => `Current PR status rollup: ${value}`
        ),
        pullRequestMergeState: pullRequest?.mergeStateStatus ?? "",
        pullRequestMergeStateLine: formatOptionalLine(
          pullRequest?.mergeStateStatus,
          (value) => `Merge state: ${value}`
        ),
        unresolvedConversationCount:
          pullRequest?.unresolvedConversationCount !== undefined
            ? String(pullRequest.unresolvedConversationCount)
            : "",
        unresolvedConversationCountLine:
          pullRequest?.unresolvedConversationCount !== undefined
            ? `Unresolved review conversations: ${pullRequest.unresolvedConversationCount}`
            : "",
        changedFiles: changedFiles.join("\n"),
        changedFilesBlock:
          changedFiles.length > 0
            ? ["Changed files snapshot:", ...changedFiles].join("\n")
            : "",
        language
      }
    );

    return {
      type: "claude",
      agent: "code-reviewer",
      permissionMode: "plan",
      prompt
    };
  }

  public buildManualReviewRunMetadata(task: Task): Record<string, string> {
    return {
      trigger: "manual_claude_review",
      reviewAgent: "claude_code",
      reviewBaseRef: task.worktree.baseRef,
      reviewBranch: task.worktree.branchName,
      reviewPullRequestUrl: task.pullRequestUrl ?? ""
    };
  }

  private async moveTaskToColumnOnFailure(
    taskId: string,
    column: Task["column"]
  ): Promise<void> {
    const tasks = this.deps.store.listTasks();
    const taskEntry = tasks.find((entry) => entry.id === taskId);
    if (!taskEntry || taskEntry.column === column) {
      return;
    }

    taskEntry.column = column;
    taskEntry.order = this.deps.topOrder(column, taskId);
    taskEntry.updatedAt = new Date().toISOString();
    this.deps.store.setTasks(tasks);
    await this.deps.store.save();
    this.deps.events.publish({
      type: "task.updated",
      action: "updated",
      taskId: taskEntry.id,
      task: taskEntry
    });
  }

  private async buildPullRequestReviewBody(
    task: Task,
    run: Run
  ): Promise<string | undefined> {
    const summary = run.metadata?.reviewSummary?.trim();
    const narrative = await this.extractReviewerNarrative(run.id);
    const sections = [
      "## Workhorse Claude Review",
      `**Task:** ${task.title}`,
      `**Verdict:** ${this.formatReviewVerdictLabel(this.resolveGitHubReviewAction(run.metadata?.reviewVerdict))}`,
      narrative || undefined,
      summary && summary !== narrative ? `**Summary:** ${summary}` : undefined,
      `<!-- workhorse-review-run:${run.id} -->`
    ]
      .filter((section): section is string => Boolean(section))
      .join("\n\n")
      .trim();

    if (!sections) {
      return undefined;
    }

    if (sections.length <= 12_000) {
      return sections;
    }

    return `${sections.slice(0, 11_900).trim()}\n\n[review truncated]\n\n<!-- workhorse-review-run:${run.id} -->`;
  }

  private async extractReviewerNarrative(runId: string): Promise<string | undefined> {
    const entries = await this.deps.store.readLogEntries(runId);
    const raw = entries
      .filter((entry) => entry.kind === "agent")
      .map((entry) => entry.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (!raw) {
      return undefined;
    }

    const cleaned = stripStructuredReviewBlocks(raw);
    return cleaned || undefined;
  }

  private resolveGitHubReviewAction(verdict?: string): GitHubPullRequestReviewAction {
    switch (verdict?.trim().toLowerCase()) {
      case "approve":
        return "approve";
      case "request_changes":
        return "request_changes";
      default:
        return "comment";
    }
  }

  private formatGitHubReviewAction(action: GitHubPullRequestReviewAction): string {
    switch (action) {
      case "approve":
        return "GitHub approval";
      case "request_changes":
        return "GitHub request-changes";
      default:
        return "GitHub comment";
    }
  }

  private formatReviewVerdictLabel(action: GitHubPullRequestReviewAction): string {
    switch (action) {
      case "approve":
        return "Approve";
      case "request_changes":
        return "Request Changes";
      default:
        return "Comment";
    }
  }

  private extractRepositoryFullNameFromPullRequestUrl(
    pullRequestUrl?: string
  ): string | undefined {
    if (!pullRequestUrl) {
      return undefined;
    }

    try {
      const url = new URL(pullRequestUrl);
      if (url.hostname.toLowerCase() !== "github.com") {
        return undefined;
      }

      const [owner, name] = url.pathname.split("/").filter(Boolean);
      if (!owner || !name) {
        return undefined;
      }

      return `${owner}/${name}`.toLowerCase();
    } catch {
      return undefined;
    }
  }

  private isSelfReviewError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /can.?not (approve|request changes on) your own/iu.test(message);
  }

  private async appendReviewPublicationLog(
    taskId: string,
    runId: string,
    title: string,
    text: string
  ): Promise<void> {
    await this.deps.appendAndPublishRunOutput(
      taskId,
      runId,
      createRunLogEntry(runId, {
        kind: "system",
        stream: "system",
        title,
        text,
        source: "GitHub"
      })
    );
  }
}
