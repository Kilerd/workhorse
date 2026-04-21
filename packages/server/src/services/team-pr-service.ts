import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AgentTeam, Task, TeamPrStrategy } from "@workhorse/contracts";

import type { EventBus } from "../ws/event-bus.js";
import { normalizeGitHubRepositoryFullName } from "../lib/github.js";
import { createId } from "../lib/id.js";
import type { StateStore } from "../persistence/state-store.js";
import { truncateTeamMessagePayload } from "./team-coordinator-service.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// PrCreator interface — injectable for tests
// ---------------------------------------------------------------------------

export interface PrCreator {
  pushBranch(worktreePath: string, branchName: string): Promise<void>;
  resolveRepoFullName(rootPath: string): Promise<string | undefined>;
  createPullRequest(opts: {
    repo: string;
    title: string;
    body: string;
    base: string;
    head: string;
  }): Promise<string>;
}

export class DefaultPrCreator implements PrCreator {
  async pushBranch(worktreePath: string, branchName: string): Promise<void> {
    await execFileAsync("git", ["-C", worktreePath, "push", "-u", "origin", branchName], {
      encoding: "utf8"
    });
  }

  async resolveRepoFullName(rootPath: string): Promise<string | undefined> {
    try {
      const result = await execFileAsync(
        "git",
        ["-C", rootPath, "remote", "get-url", "origin"],
        { encoding: "utf8" }
      );
      return normalizeGitHubRepositoryFullName(result.stdout.trim());
    } catch {
      return undefined;
    }
  }

  async createPullRequest(opts: {
    repo: string;
    title: string;
    body: string;
    base: string;
    head: string;
  }): Promise<string> {
    const result = await execFileAsync(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        opts.repo,
        "--title",
        opts.title,
        "--body",
        opts.body,
        "--base",
        opts.base,
        "--head",
        opts.head
      ],
      { encoding: "utf8" }
    );
    return result.stdout.trim();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPrBody(task: Task, parentTaskTitle: string): string {
  const description =
    task.description.length > 500
      ? task.description.slice(0, 500) + "..."
      : task.description;
  return [
    `## Subtask of: ${parentTaskTitle}`,
    "",
    description || task.title,
    "",
    "---",
    "Auto-created by Workhorse Agent Team"
  ].join("\n");
}

// ---------------------------------------------------------------------------
// TeamPrService
// ---------------------------------------------------------------------------

export class TeamPrService {
  constructor(
    private readonly store: StateStore,
    private readonly events: EventBus,
    private readonly prCreator: PrCreator = new DefaultPrCreator()
  ) {}

  /**
   * Push branch and create a GitHub PR for an approved subtask.
   * Only "independent" strategy is supported in v1.
   * Best-effort: failures are reported via team message but never propagate.
   * @param source Either an AgentTeam (legacy) or a minimal object with prStrategy (workspace path)
   */
  async createSubtaskPullRequest(
    task: Task,
    source: AgentTeam | { prStrategy: TeamPrStrategy }
  ): Promise<string | null> {
    if (source.prStrategy !== "independent") {
      return null;
    }

    const worktreePath = task.worktree.path;
    const branchName = task.worktree.branchName;
    if (!worktreePath || !branchName) {
      return null;
    }

    const workspace = this.store.listWorkspaces().find((w) => w.id === task.workspaceId);
    if (!workspace) {
      return null;
    }

    const parentTask = this.store.listTasks().find((t) => t.id === task.parentTaskId);
    const parentTaskTitle = parentTask?.title ?? "unknown task";

    let pushError: string | null = null;
    try {
      await this.prCreator.pushBranch(worktreePath, branchName);
    } catch (err) {
      pushError = err instanceof Error ? err.message : String(err);
    }

    if (pushError) {
      this.appendTeamStatusMessage(
        task,
        source,
        `Failed to push branch for subtask "${task.title}": ${pushError}`
      );
      return null;
    }

    const repoFullName = await this.prCreator.resolveRepoFullName(workspace.rootPath);
    if (!repoFullName) {
      this.appendTeamStatusMessage(
        task,
        source,
        `Failed to create PR for subtask "${task.title}": could not determine GitHub repository`
      );
      return null;
    }

    let prUrl: string | null = null;
    try {
      prUrl = await this.prCreator.createPullRequest({
        repo: repoFullName,
        title: task.title,
        body: buildPrBody(task, parentTaskTitle),
        base: "main",
        head: branchName
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendTeamStatusMessage(
        task,
        source,
        `Failed to create PR for subtask "${task.title}": ${message}`
      );
      return null;
    }

    // Persist the PR URL onto the task
    const updatedTask = await this.store.updateState((state) => {
      const idx = state.tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) {
        return null;
      }
      state.tasks[idx]!.pullRequestUrl = prUrl!;
      state.tasks[idx]!.updatedAt = new Date().toISOString();
      return { ...state.tasks[idx] } as Task;
    });
    if (updatedTask) {
      this.events.publish({
        type: "task.updated",
        action: "updated",
        taskId: updatedTask.id,
        task: updatedTask
      });
    }

    this.appendTeamStatusMessage(
      task,
      source,
      `PR created for subtask "${task.title}": ${prUrl}`
    );
    return prUrl;
  }

  private appendTeamStatusMessage(
    task: Task,
    source: AgentTeam | { prStrategy: TeamPrStrategy },
    content: string
  ): void {
    const now = new Date().toISOString();
    const truncated = truncateTeamMessagePayload(content);
    // Dispatch to team_messages (legacy) or task_messages (workspace-agent path)
    if ("agents" in source) {
      // AgentTeam has an agents field (more stable discriminant than "id")
      this.store.appendTeamMessage({
        id: createId(),
        teamId: source.id,
        parentTaskId: task.parentTaskId!,
        taskId: task.id,
        agentName: "system",
        senderType: "system",
        messageType: "status",
        content: truncated,
        createdAt: now
      });
      this.events.publish({
        type: "team.agent.message",
        teamId: source.id,
        parentTaskId: task.parentTaskId!,
        fromAgentId: "system",
        messageType: "status",
        payload: truncated
      });
    } else {
      // Workspace-agent path: use task_messages keyed by workspaceId
      const message = {
        id: createId(),
        parentTaskId: task.parentTaskId!,
        taskId: task.id,
        agentName: "system",
        senderType: "system",
        messageType: "status",
        content: truncated,
        createdAt: now
      } as const;
      this.store.appendTaskMessage(message);
      this.events.publish({
        type: "task.message.created",
        workspaceId: task.workspaceId,
        parentTaskId: task.parentTaskId!,
        message
      });
    }
  }
}
