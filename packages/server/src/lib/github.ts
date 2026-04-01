import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";

import { AppError } from "./errors.js";

const execFileAsync = promisify(execFile);

export type GitHubCheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface GitHubPullRequestSummary {
  number: number;
  url: string;
  headRef: string;
  baseRef: string;
  headSha?: string;
  baseSha?: string;
  mergeable?: string;
  mergeStateStatus?: string;
}

export interface GitHubPullRequestCheck {
  bucket: GitHubCheckBucket;
  state: string;
  name: string;
  link?: string;
}

export interface GitHubPullRequestProvider {
  isAvailable(): Promise<boolean>;
  findOpenPullRequest(
    repositoryFullName: string,
    headRef: string
  ): Promise<GitHubPullRequestSummary | null>;
  listRequiredChecks(
    repositoryFullName: string,
    pullRequest: number | string
  ): Promise<GitHubPullRequestCheck[]>;
}

class GhCommandError extends Error {
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
    this.name = "GhCommandError";
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.exitCode = options.exitCode;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readStringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumberField(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

export function normalizeGitHubRepositoryFullName(
  value: string
): string | undefined {
  const trimmed = value.trim().replace(/\.git$/i, "");
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("git@github.com:")) {
    return trimmed.slice("git@github.com:".length).toLowerCase();
  }

  if (trimmed.startsWith("ssh://git@github.com/")) {
    return trimmed.slice("ssh://git@github.com/".length).toLowerCase();
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") {
      return undefined;
    }

    return url.pathname.replace(/^\/+/, "").toLowerCase();
  } catch {
    if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }

    return undefined;
  }
}

async function runGh(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("gh", args, {
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

    throw new GhCommandError(execError.message, {
      stdout: execError.stdout,
      stderr: execError.stderr,
      exitCode: typeof execError.code === "number" ? execError.code : undefined
    });
  }
}

function parsePullRequestList(payload: unknown): GitHubPullRequestSummary[] {
  if (!Array.isArray(payload)) {
    throw new AppError(
      502,
      "GITHUB_MONITOR_RESPONSE_INVALID",
      "gh pr list returned an unexpected payload"
    );
  }

  return payload.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) {
      return [];
    }

    const number = readNumberField(record, "number");
    const url = readStringField(record, "url");
    const headRef = readStringField(record, "headRefName");
    const baseRef = readStringField(record, "baseRefName");
    if (number === undefined || !url || !headRef || !baseRef) {
      return [];
    }

    return [{
      number,
      url,
      headRef,
      baseRef,
      headSha: readStringField(record, "headRefOid"),
      baseSha: readStringField(record, "baseRefOid"),
      mergeable: readStringField(record, "mergeable"),
      mergeStateStatus: readStringField(record, "mergeStateStatus")
    }] satisfies GitHubPullRequestSummary[];
  });
}

function parseCheckList(payload: unknown): GitHubPullRequestCheck[] {
  if (!Array.isArray(payload)) {
    throw new AppError(
      502,
      "GITHUB_MONITOR_RESPONSE_INVALID",
      "gh pr checks returned an unexpected payload"
    );
  }

  return payload.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) {
      return [];
    }

    const bucket = readStringField(record, "bucket");
    const state = readStringField(record, "state");
    const name = readStringField(record, "name");
    if (!bucket || !state || !name) {
      return [];
    }

    return [{
      bucket: bucket as GitHubCheckBucket,
      state,
      name,
      link: readStringField(record, "link")
    }] satisfies GitHubPullRequestCheck[];
  });
}

export class GhCliPullRequestProvider implements GitHubPullRequestProvider {
  private availability?: boolean;

  public async isAvailable(): Promise<boolean> {
    if (this.availability === true) {
      return true;
    }

    try {
      await runGh(["auth", "status", "--hostname", "github.com"]);
      this.availability = true;
    } catch {
      this.availability = false;
    }

    return this.availability;
  }

  public async findOpenPullRequest(
    repositoryFullName: string,
    headRef: string
  ): Promise<GitHubPullRequestSummary | null> {
    const repository = normalizeGitHubRepositoryFullName(repositoryFullName);
    if (!repository) {
      throw new AppError(
        400,
        "GITHUB_REPOSITORY_INVALID",
        `Invalid GitHub repository: ${repositoryFullName}`
      );
    }

    try {
      const { stdout } = await runGh([
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        headRef,
        "--state",
        "open",
        "--limit",
        "1",
        "--json",
        "number,url,headRefName,baseRefName,headRefOid,baseRefOid,mergeable,mergeStateStatus"
      ]);

      return parsePullRequestList(JSON.parse(stdout))[0] ?? null;
    } catch (error) {
      throw new AppError(
        502,
        "GITHUB_MONITOR_REQUEST_FAILED",
        `gh pr list failed for ${repository}#${headRef}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async listRequiredChecks(
    repositoryFullName: string,
    pullRequest: number | string
  ): Promise<GitHubPullRequestCheck[]> {
    const repository = normalizeGitHubRepositoryFullName(repositoryFullName);
    if (!repository) {
      throw new AppError(
        400,
        "GITHUB_REPOSITORY_INVALID",
        `Invalid GitHub repository: ${repositoryFullName}`
      );
    }

    try {
      const { stdout } = await runGh([
        "pr",
        "checks",
        "--repo",
        repository,
        String(pullRequest),
        "--required",
        "--json",
        "bucket,state,name,link"
      ]);

      return parseCheckList(JSON.parse(stdout));
    } catch (error) {
      if (error instanceof GhCommandError && error.exitCode === 8 && error.stdout.trim()) {
        return parseCheckList(JSON.parse(error.stdout));
      }

      throw new AppError(
        502,
        "GITHUB_MONITOR_REQUEST_FAILED",
        `gh pr checks failed for ${repository}#${pullRequest}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
