import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";

import { AppError } from "./errors.js";

const execFileAsync = promisify(execFile);
const GITHUB_PULL_REQUEST_URL_PATTERN =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:[?#][^\s<>]*)?/gi;
const GITHUB_PULL_REQUEST_REVIEW_THREADS_QUERY = `
query(
  $owner: String!,
  $name: String!,
  $number: Int!,
  $endCursor: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          leadingComment: comments(first: 1) {
            nodes {
              author {
                login
              }
              body
              createdAt
              updatedAt
              url
            }
          }
          latestComment: comments(last: 1) {
            nodes {
              author {
                login
              }
              body
              createdAt
              updatedAt
              url
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

export type GitHubCheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface GitHubPullRequestFeedbackItem {
  source: "comment" | "review";
  author?: string;
  body?: string;
  url?: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GitHubPullRequestConversationItem {
  id: string;
  author?: string;
  body?: string;
  url?: string;
  path?: string;
  line?: number;
  isOutdated?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface GitHubPullRequestSummary {
  number: number;
  url: string;
  headRef: string;
  baseRef: string;
  headSha?: string;
  baseSha?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollupState?: string;
  feedbackCount?: number;
  feedbackUpdatedAt?: string;
  feedbackItems?: GitHubPullRequestFeedbackItem[];
  unresolvedConversationCount?: number;
  unresolvedConversationUpdatedAt?: string;
  unresolvedConversationItems?: GitHubPullRequestConversationItem[];
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
  findMergedPullRequest(
    repositoryFullName: string,
    headRef: string
  ): Promise<GitHubPullRequestSummary | null>;
  listRequiredChecks(
    repositoryFullName: string,
    pullRequest: number | string
  ): Promise<GitHubPullRequestCheck[]>;
  addPullRequestComment(
    repositoryFullName: string,
    pullRequest: number | string,
    body: string
  ): Promise<void>;
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

function readBooleanField(
  record: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNodeArrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (Array.isArray(value)) {
    return value;
  }

  const valueRecord = asRecord(value);
  const nodes = valueRecord?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function parseFeedbackItem(
  payload: unknown,
  source: GitHubPullRequestFeedbackItem["source"]
): GitHubPullRequestFeedbackItem | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const author = readStringField(asRecord(record.author) ?? {}, "login");
  const createdAt =
    source === "review"
      ? readStringField(record, "submittedAt") ??
        readStringField(record, "createdAt") ??
        readStringField(record, "updatedAt")
      : readStringField(record, "createdAt") ?? readStringField(record, "updatedAt");
  const updatedAt = readStringField(record, "updatedAt") ?? createdAt;

  return {
    source,
    author,
    body: readStringField(record, "body"),
    url: readStringField(record, "url"),
    state: readStringField(record, "state"),
    createdAt,
    updatedAt
  };
}

function parseConversationItem(payload: unknown): GitHubPullRequestConversationItem | null {
  const record = asRecord(payload);
  if (!record || readBooleanField(record, "isResolved") !== false) {
    return null;
  }

  const id = readStringField(record, "id");
  if (!id) {
    return null;
  }

  const leadingComment = readNodeArrayField(record, "leadingComment")
    .map((item) => parseFeedbackItem(item, "comment"))
    .find((item): item is GitHubPullRequestFeedbackItem => Boolean(item));
  const latestComment = readNodeArrayField(record, "latestComment")
    .map((item) => parseFeedbackItem(item, "comment"))
    .find((item): item is GitHubPullRequestFeedbackItem => Boolean(item));

  return {
    id,
    author: leadingComment?.author ?? latestComment?.author,
    body: leadingComment?.body ?? latestComment?.body,
    url: leadingComment?.url ?? latestComment?.url,
    path: readStringField(record, "path"),
    line: readNumberField(record, "line") ?? readNumberField(record, "originalLine"),
    isOutdated: readBooleanField(record, "isOutdated"),
    createdAt: leadingComment?.createdAt ?? latestComment?.createdAt,
    updatedAt:
      latestComment?.updatedAt ??
      latestComment?.createdAt ??
      leadingComment?.updatedAt ??
      leadingComment?.createdAt
  };
}

function compareOptionalTimestamps(left?: string, right?: string): number {
  const leftMs = left ? Date.parse(left) : Number.NaN;
  const rightMs = right ? Date.parse(right) : Number.NaN;

  const leftValid = Number.isFinite(leftMs);
  const rightValid = Number.isFinite(rightMs);
  if (leftValid && rightValid) {
    return rightMs - leftMs;
  }
  if (leftValid) {
    return -1;
  }
  if (rightValid) {
    return 1;
  }

  return 0;
}

function pickLatestTimestamp(values: Array<string | undefined>): string | undefined {
  const timestamps = values.filter((value): value is string => Boolean(value));
  if (timestamps.length === 0) {
    return undefined;
  }

  return timestamps.sort(compareOptionalTimestamps)[0];
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

export function extractGitHubPullRequestUrl(value: string): string | undefined {
  const matches = value.match(GITHUB_PULL_REQUEST_URL_PATTERN);
  if (!matches?.length) {
    return undefined;
  }

  return matches[matches.length - 1]?.replace(/[),.;!?]+$/u, "");
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

function parseStatusCheckRollupState(payload: unknown): string | undefined {
  if (Array.isArray(payload)) {
    const states = payload
      .map((item) => readStringField(asRecord(item) ?? {}, "state"))
      .filter((value): value is string => Boolean(value));
    return states[0];
  }

  const record = asRecord(payload);
  if (!record) {
    return undefined;
  }

  const directState = readStringField(record, "state");
  if (directState) {
    return directState;
  }

  const contexts = readNodeArrayField(record, "contexts");
  const contextState = contexts
    .map((item) => readStringField(asRecord(item) ?? {}, "state"))
    .find((value): value is string => Boolean(value));
  return contextState;
}

function parsePullRequestDetail(payload: unknown): GitHubPullRequestSummary {
  const record = asRecord(payload);
  if (!record) {
    throw new AppError(
      502,
      "GITHUB_MONITOR_RESPONSE_INVALID",
      "gh pr view returned an unexpected payload"
    );
  }

  const number = readNumberField(record, "number");
  const url = readStringField(record, "url");
  const headRef = readStringField(record, "headRefName");
  const baseRef = readStringField(record, "baseRefName");
  if (number === undefined || !url || !headRef || !baseRef) {
    throw new AppError(
      502,
      "GITHUB_MONITOR_RESPONSE_INVALID",
      "gh pr view omitted required pull request fields"
    );
  }

  const feedbackItems = [
    ...readNodeArrayField(record, "comments")
      .map((item) => parseFeedbackItem(item, "comment"))
      .filter((item): item is GitHubPullRequestFeedbackItem => Boolean(item)),
    ...readNodeArrayField(record, "latestReviews")
      .map((item) => parseFeedbackItem(item, "review"))
      .filter((item): item is GitHubPullRequestFeedbackItem => Boolean(item))
  ].sort((left, right) =>
    compareOptionalTimestamps(left.updatedAt ?? left.createdAt, right.updatedAt ?? right.createdAt)
  );

  return {
    number,
    url,
    headRef,
    baseRef,
    headSha: readStringField(record, "headRefOid"),
    baseSha: readStringField(record, "baseRefOid"),
    mergeable: readStringField(record, "mergeable"),
    mergeStateStatus: readStringField(record, "mergeStateStatus"),
    reviewDecision: readStringField(record, "reviewDecision"),
    statusCheckRollupState: parseStatusCheckRollupState(record.statusCheckRollup),
    feedbackCount: feedbackItems.length,
    feedbackUpdatedAt: pickLatestTimestamp(
      feedbackItems.map((item) => item.updatedAt ?? item.createdAt)
    ),
    feedbackItems
  };
}

function parseReviewThreadPage(payload: unknown): GitHubPullRequestConversationItem[] {
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  const repository = asRecord(data?.repository);
  const pullRequest = asRecord(repository?.pullRequest);
  if (!pullRequest) {
    return [];
  }

  return readNodeArrayField(pullRequest, "reviewThreads")
    .map((item) => parseConversationItem(item))
    .filter((item): item is GitHubPullRequestConversationItem => Boolean(item));
}

function parseUnresolvedConversationPages(
  payload: unknown
): Pick<
  GitHubPullRequestSummary,
  "unresolvedConversationCount" | "unresolvedConversationUpdatedAt" | "unresolvedConversationItems"
> {
  const pages = Array.isArray(payload) ? payload : [payload];
  const unresolvedConversationItems = pages
    .flatMap((page) => parseReviewThreadPage(page))
    .sort((left, right) => compareOptionalTimestamps(left.updatedAt, right.updatedAt));

  return {
    unresolvedConversationCount: unresolvedConversationItems.length,
    unresolvedConversationUpdatedAt: pickLatestTimestamp(
      unresolvedConversationItems.map((item) => item.updatedAt ?? item.createdAt)
    ),
    unresolvedConversationItems
  };
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
    const summary = await this.findPullRequestByState(repositoryFullName, headRef, "open");
    if (!summary) {
      return null;
    }

    return this.loadPullRequestDetail(repositoryFullName, summary.number);
  }

  public async findMergedPullRequest(
    repositoryFullName: string,
    headRef: string
  ): Promise<GitHubPullRequestSummary | null> {
    return this.findPullRequestByState(repositoryFullName, headRef, "merged");
  }

  private async findPullRequestByState(
    repositoryFullName: string,
    headRef: string,
    state: "open" | "merged"
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
        state,
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
        `gh pr list failed for ${repository}#${headRef} (${state}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async loadPullRequestDetail(
    repositoryFullName: string,
    pullRequest: number | string
  ): Promise<GitHubPullRequestSummary> {
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
        "view",
        "--repo",
        repository,
        String(pullRequest),
        "--json",
        [
          "number",
          "url",
          "headRefName",
          "baseRefName",
          "headRefOid",
          "baseRefOid",
          "mergeable",
          "mergeStateStatus",
          "reviewDecision",
          "statusCheckRollup",
          "comments",
          "latestReviews"
        ].join(",")
      ]);

      const [owner, name] = repository.split("/", 2);
      if (!owner || !name) {
        throw new AppError(
          400,
          "GITHUB_REPOSITORY_INVALID",
          `Invalid GitHub repository: ${repositoryFullName}`
        );
      }

      const { stdout: reviewThreadsStdout } = await runGh([
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${Number(pullRequest)}`,
        "-f",
        `query=${GITHUB_PULL_REQUEST_REVIEW_THREADS_QUERY}`
      ]);

      return {
        ...parsePullRequestDetail(JSON.parse(stdout)),
        ...parseUnresolvedConversationPages(JSON.parse(reviewThreadsStdout))
      };
    } catch (error) {
      throw new AppError(
        502,
        "GITHUB_MONITOR_REQUEST_FAILED",
        `gh pr view failed for ${repository}#${pullRequest}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async addPullRequestComment(
    repositoryFullName: string,
    pullRequest: number | string,
    body: string
  ): Promise<void> {
    const repository = normalizeGitHubRepositoryFullName(repositoryFullName);
    if (!repository) {
      throw new AppError(
        400,
        "GITHUB_REPOSITORY_INVALID",
        `Invalid GitHub repository: ${repositoryFullName}`
      );
    }

    try {
      await runGh([
        "pr",
        "comment",
        "--repo",
        repository,
        String(pullRequest),
        "--body",
        body
      ]);
    } catch (error) {
      throw new AppError(
        502,
        "GITHUB_MONITOR_REQUEST_FAILED",
        `gh pr comment failed for ${repository}#${pullRequest}: ${error instanceof Error ? error.message : String(error)}`
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
      if (error instanceof GhCommandError) {
        const combinedOutput = `${error.stdout}\n${error.stderr}`.trim();
        if (/no checks reported/i.test(combinedOutput)) {
          return [];
        }
      }

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
