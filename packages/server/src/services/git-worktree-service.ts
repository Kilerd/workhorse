import { execFile, type ExecFileException } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { Task, TaskWorktree, Workspace, WorkspaceGitRef } from "@workhorse/contracts";

import { AppError } from "../lib/errors.js";
import { normalizeGitHubRepositoryFullName } from "../lib/github.js";
import {
  createTaskWorktree,
  deriveTaskBranchFallbackName,
  deriveTaskWorktreePath,
  pickDefaultGitRef
} from "../lib/task-worktree.js";

const execFileAsync = promisify(execFile);

class GitCommandError extends Error {
  public readonly stdout: string;

  public readonly stderr: string;

  public readonly exitCode?: number;

  public constructor(
    message: string,
    options: {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    } = {}
  ) {
    super(message);
    this.name = "GitCommandError";
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.exitCode = options.exitCode;
  }
}

interface WorktreeEntry {
  path: string;
}

function normalizeMessage(error: GitCommandError): string {
  return (error.stderr || error.stdout || error.message).trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function normalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export class GitWorktreeService {
  public async getGitHubRepositoryFullName(
    workspace: Workspace
  ): Promise<string | undefined> {
    this.ensureGitWorkspace(workspace);

    try {
      const { stdout } = await this.runGit(workspace.rootPath, ["remote", "-v"]);
      for (const line of stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        const remoteUrl = parts[1];
        if (!remoteUrl) {
          continue;
        }

        const fullName = normalizeGitHubRepositoryFullName(remoteUrl);
        if (fullName) {
          return fullName;
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  public async listRefs(workspace: Workspace): Promise<WorkspaceGitRef[]> {
    this.ensureGitWorkspace(workspace);

    const { stdout } = await this.runGit(workspace.rootPath, [
      "for-each-ref",
      "--format=%(refname:short)\t%(refname)",
      "refs/remotes",
      "refs/heads"
    ]);

    const refs = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const [name, fullName] = line.split("\t");
        if (!name || !fullName) {
          return [];
        }
        const kind = fullName.startsWith("refs/remotes/") ? "remote" : "local";
        return [{
          name,
          kind
        }] as const;
      })
      .filter((ref) => ref.name !== "origin/HEAD")
      .sort((left, right) => left.name.localeCompare(right.name));

    const defaultRef = pickDefaultGitRef(
      refs.map((ref) => ({
        ...ref,
        isDefault: false
      }))
    );

    return refs.map((ref) => ({
      ...ref,
      isDefault: ref.name === defaultRef?.name
    }));
  }

  public async resolveBaseRef(
    workspace: Workspace,
    requestedBaseRef?: string
  ): Promise<string> {
    this.ensureGitWorkspace(workspace);
    const refs = await this.listRefs(workspace);
    const desired = requestedBaseRef?.trim();

    if (desired) {
      const exists = refs.some((ref) => ref.name === desired);
      if (!exists) {
        throw new AppError(
          400,
          "INVALID_TASK_WORKTREE_BASE_REF",
          `Git ref not found: ${desired}`
        );
      }
      return desired;
    }

    const defaultRef = pickDefaultGitRef(refs);
    if (!defaultRef) {
      throw new AppError(
        409,
        "WORKSPACE_GIT_REFS_UNAVAILABLE",
        "No Git refs are available for this workspace"
      );
    }

    return defaultRef.name;
  }

  public async reconcileTaskWorktree(
    workspace: Workspace,
    task: Task
  ): Promise<TaskWorktree> {
    if (!workspace.isGitRepo) {
      return createTaskWorktree(task.id, task.title, {
        workspace
      });
    }

    const current = task.worktree;
    const currentPath = current.path?.trim();
    if (!currentPath) {
      if (current.status === "ready" || current.status === "cleanup_pending") {
        return {
          ...current,
          status: "removed",
          path: undefined,
          cleanupReason: undefined
        };
      }
      return current;
    }

    const normalizedCurrentPath = await normalizePath(currentPath);
    const registered = await this.listRegisteredWorktrees(workspace);
    const isRegistered = registered.some((entry) => entry.path === normalizedCurrentPath);
    const hasDirectory = await pathExists(currentPath);
    const hasGitMarker = await pathExists(join(currentPath, ".git"));

    if (!isRegistered || !hasDirectory || !hasGitMarker) {
      return {
        ...current,
        status: "removed",
        path: undefined,
        cleanupReason: undefined
      };
    }

    return {
      ...current,
      path: normalizedCurrentPath
    };
  }

  public async ensureTaskWorktree(
    workspace: Workspace,
    task: Task
  ): Promise<TaskWorktree> {
    this.ensureGitWorkspace(workspace);
    const reconciled = await this.reconcileTaskWorktree(workspace, task);

    if (reconciled.status === "ready") {
      return {
        ...reconciled,
        cleanupReason: undefined
      };
    }

    if (reconciled.status === "cleanup_pending" && reconciled.path) {
      return {
        ...reconciled,
        status: "ready",
        cleanupReason: undefined
      };
    }

    const baseRef = reconciled.baseRef.trim();
    if (!baseRef) {
      throw new AppError(
        400,
        "TASK_WORKTREE_BASE_REF_REQUIRED",
        "Task worktree base ref is required"
      );
    }

    let nextPath = deriveTaskWorktreePath(workspace, task);
    if (await pathExists(nextPath)) {
      const fallbackPath = deriveTaskWorktreePath(workspace, task, {
        preserveAutoTaskId: true
      });

      if (fallbackPath !== nextPath && !(await pathExists(fallbackPath))) {
        nextPath = fallbackPath;
      } else {
        throw new AppError(
          409,
          "TASK_WORKTREE_PATH_EXISTS",
          `Task worktree path already exists: ${nextPath}`
        );
      }
    }

    await mkdir(dirname(nextPath), { recursive: true });

    let lastSyncedBaseAt = reconciled.lastSyncedBaseAt;
    if (await this.isRemoteTrackingRef(workspace.rootPath, baseRef)) {
      const [remote = "", ...branchParts] = baseRef.split("/");
      const branch = branchParts.join("/");
      try {
        await this.runGit(workspace.rootPath, ["fetch", remote, branch]);
        lastSyncedBaseAt = new Date().toISOString();
      } catch (error) {
        throw this.toAppError(
          error,
          "TASK_WORKTREE_FETCH_FAILED",
          `Failed to fetch ${baseRef}`
        );
      }
    }

    let branchName = reconciled.branchName;
    let branchExists = await this.branchExists(workspace.rootPath, branchName);

    if (branchExists) {
      const fallbackBranchName = deriveTaskBranchFallbackName(
        branchName,
        task.id,
        task.title
      );

      if (fallbackBranchName !== branchName) {
        branchName = fallbackBranchName;
        branchExists = await this.branchExists(workspace.rootPath, branchName);
      }
    }

    const addArgs = branchExists
      ? ["worktree", "add", nextPath, branchName]
      : ["worktree", "add", "-b", branchName, nextPath, baseRef];

    try {
      await this.runGit(workspace.rootPath, addArgs);
    } catch (error) {
      const message = normalizeMessage(error as GitCommandError);
      if (message.includes("already checked out")) {
        throw new AppError(
          409,
          "TASK_WORKTREE_BRANCH_IN_USE",
          message
        );
      }
      if (message.includes("invalid reference") || message.includes("not a valid object name")) {
        throw new AppError(
          400,
          "INVALID_TASK_WORKTREE_BASE_REF",
          message
        );
      }
      throw this.toAppError(
        error,
        "TASK_WORKTREE_CREATE_FAILED",
        message || "Failed to create task worktree"
      );
    }

    return {
      ...reconciled,
      branchName,
      path: await normalizePath(nextPath),
      status: "ready",
      cleanupReason: undefined,
      lastSyncedBaseAt
    };
  }

  public async cleanupTaskWorktree(
    workspace: Workspace,
    task: Task
  ): Promise<TaskWorktree> {
    if (!workspace.isGitRepo) {
      return createTaskWorktree(task.id, task.title, {
        workspace
      });
    }

    const reconciled = await this.reconcileTaskWorktree(workspace, task);
    const currentPath = reconciled.path?.trim();
    if (!currentPath) {
      return {
        ...reconciled,
        status: "removed",
        path: undefined,
        cleanupReason: undefined
      };
    }

    try {
      await this.runGit(workspace.rootPath, ["worktree", "remove", currentPath]);
      return {
        ...reconciled,
        status: "removed",
        path: undefined,
        cleanupReason: undefined
      };
    } catch (error) {
      return {
        ...reconciled,
        status: "cleanup_pending",
        cleanupReason: normalizeMessage(error as GitCommandError) || "Cleanup failed"
      };
    }
  }

  public async fetchWorkspace(workspace: Workspace, remoteName = "origin"): Promise<void> {
    this.ensureGitWorkspace(workspace);

    try {
      await this.runGit(workspace.rootPath, ["fetch", remoteName, "--prune"]);
    } catch (error) {
      throw this.toAppError(
        error,
        "TASK_WORKTREE_FETCH_FAILED",
        "Failed to fetch the workspace remotes"
      );
    }
  }

  private ensureGitWorkspace(workspace: Workspace): void {
    if (!workspace.isGitRepo) {
      throw new AppError(
        409,
        "WORKSPACE_NOT_GIT_REPO",
        "Workspace is not a Git repository"
      );
    }
  }

  private async listRegisteredWorktrees(workspace: Workspace): Promise<WorktreeEntry[]> {
    const { stdout } = await this.runGit(workspace.rootPath, ["worktree", "list", "--porcelain"]);
    const entries: WorktreeEntry[] = [];

    for (const line of stdout.split("\n")) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      entries.push({
        path: await normalizePath(line.slice("worktree ".length).trim())
      });
    }

    return entries;
  }

  private async branchExists(cwd: string, branchName: string): Promise<boolean> {
    try {
      await this.runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async isRemoteTrackingRef(cwd: string, refName: string): Promise<boolean> {
    try {
      await this.runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/${refName}`]);
      return true;
    } catch {
      return false;
    }
  }

  public async getWorktreeDiff(
    worktreePath: string,
    baseRef: string
  ): Promise<string> {
    const result = await execFileAsync("git", ["diff", `${baseRef}...HEAD`, "--", "."], {
      cwd: worktreePath,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    return result.stdout;
  }

  private async runGit(
    cwd: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr
      };
    } catch (error) {
      const execError = error as ExecFileException & {
        stdout?: string;
        stderr?: string;
      };

      throw new GitCommandError(execError.message, {
        stdout: execError.stdout,
        stderr: execError.stderr,
        exitCode: execError.code && typeof execError.code === "number" ? execError.code : undefined
      });
    }
  }

  private toAppError(error: unknown, code: string, fallbackMessage: string): AppError {
    if (error instanceof AppError) {
      return error;
    }

    const message =
      error instanceof GitCommandError
        ? normalizeMessage(error) || fallbackMessage
        : fallbackMessage;

    return new AppError(500, code, message);
  }
}
