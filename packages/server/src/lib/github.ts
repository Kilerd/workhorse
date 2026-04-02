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
        totalCount
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

export interface GitHubPullRequestFile {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface GitHubPullRequestChecksSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
}

export interface GitHubPullRequestSummary {
  number: number;
  url: string;
  headRef: string;
  baseRef: string;
  title?: string;
  state?: string;
  isDraft?: boolean;
  headSha?: string;
  baseSha?: string;
  updatedAt?: string;
  changedFiles?: number;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollupState?: string;
  threadCount?: number;
  reviewCount?: number;
  approvalCount?: number;
  changesRequestedCount?: number;
  statusChecks?: GitHubPullRequestChecksSummary;
  feedbackCount?: number;
  feedbackUpdatedAt?: string;
  feedbackItems?: GitHubPullRequestFeedbackItem[];
  unresolvedConversationCount?: number;
  unresolvedConversationUpdatedAt?: string;
  unresolvedConversationItems?: GitHubPullRequestConversationItem[];
  files?: GitHubPullRequestFile[];
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

function parsePullRequestFile(payload: unknown): GitHubPullRequestFile | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const path = readStringField(record, "path");
  if (!path) {
    return null;
  }

  return {
    path,
    additions: readNumberField(record, "additions"),
    deletions: readNumberField(record, "deletions")
  };
}

function summarizeReviewStates(payload: unknown[]): Pick<
  GitHubPullRequestSummary,
  "reviewCount" | "approvalCount" | "changesRequestedCount"
> {
  let reviewCount = 0;
  let approvalCount = 0;
  let changesRequestedCount = 0;

  for (const item of payload) {
    const state = readStringField(asRecord(item) ?? {}, "state")?.toUpperCase();
    if (!state) {
      continue;
    }

    reviewCount += 1;
    if (state === "APPROVED") {
      approvalCount += 1;
    }
    if (state === "CHANGES_REQUESTED") {
      changesRequestedCount += 1;
    }
  }

  return {
    ...(reviewCount > 0 ? { reviewCount } : {}),
    ...(approvalCount > 0 ? { approvalCount } : {}),
    ...(changesRequestedCount > 0 ? { changesRequestedCount } : {})
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

function summarizeStatusCheckRollup(
  payload: unknown
): GitHubPullRequestChecksSummary | undefined {
  const contexts = Array.isArray(payload)
    ? payload
    : readNodeArrayField(asRecord(payload) ?? {}, "contexts");
  if (contexts.length === 0) {
    return undefined;
  }

  let total = 0;
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let skipped = 0;

  for (const context of contexts) {
    const record = asRecord(context);
    const rawState = (
      readStringField(record ?? {}, "state") ??
      readStringField(record ?? {}, "conclusion")
    )?.toUpperCase();
    if (!rawState) {
      continue;
    }

    total += 1;

    if (rawState === "SUCCESS") {
      passed += 1;
      continue;
    }

    if (
      rawState === "FAILURE" ||
      rawState === "ERROR" ||
      rawState === "TIMED_OUT" ||
      rawState === "ACTION_REQUIRED"
    ) {
      failed += 1;
      continue;
    }

    if (
      rawState === "PENDING" ||
      rawState === "EXPECTED" ||
      rawState === "QUEUED" ||
      rawState === "IN_PROGRESS" ||
      rawState === "REQUESTED" ||
      rawState === "WAITING"
    ) {
      pending += 1;
      continue;
    }

    if (
      rawState === "SKIPPED" ||
      rawState === "NEUTRAL" ||
      rawState === "CANCELLED" ||
      rawState === "CANCELED"
    ) {
      skipped += 1;
      continue;
    }

    pending += 1;
  }

  if (total === 0) {
    return undefined;
  }

  return {
    total,
    passed,
    failed,
    pending,
    skipped
  };
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
  const latestReviews = readNodeArrayField(record, "latestReviews");
  const reviewStateSummary = summarizeReviewStates(latestReviews);
  const title = readStringField(record, "title");
  const state = readStringField(record, "state");
  const isDraft = readBooleanField(record, "isDraft");
  const updatedAt = readStringField(record, "updatedAt");

  return {
    number,
    url,
    headRef,
    baseRef,
    ...(title ? { title } : {}),
    ...(state ? { state } : {}),
    ...(isDraft !== undefined ? { isDraft } : {}),
    headSha: readStringField(record, "headRefOid"),
    baseSha: readStringField(record, "baseRefOid"),
    ...(updatedAt ? { updatedAt } : {}),
    changedFiles: readNumberField(record, "changedFiles"),
    mergeable: readStringField(record, "mergeable"),
    mergeStateStatus: readStringField(record, "mergeStateStatus"),
    reviewDecision: readStringField(record, "reviewDecision"),
    statusCheckRollupState: parseStatusCheckRollupState(record.statusCheckRollup),
    ...reviewStateSummary,
    statusChecks: summarizeStatusCheckRollup(record.statusCheckRollup),
    feedbackCount: feedbackItems.length,
    feedbackUpdatedAt: pickLatestTimestamp(
      feedbackItems.map((item) => item.updatedAt ?? item.createdAt)
    ),
    feedbackItems,
    files: readNodeArrayField(record, "files")
      .map((item) => parsePullRequestFile(item))
      .filter((item): item is GitHubPullRequestFile => Boolean(item))
  };
}

function parseReviewThreadPage(payload: unknown): {
  threadCount?: number;
  items: GitHubPullRequestConversationItem[];
} {
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  const repository = asRecord(data?.repository);
  const pullRequest = asRecord(repository?.pullRequest);
  if (!pullRequest) {
    return {
      items: []
    };
  }

  const reviewThreads = asRecord(pullRequest.reviewThreads);

  return {
    threadCount: readNumberField(reviewThreads ?? {}, "totalCount"),
    items: readNodeArrayField(pullRequest, "reviewThreads")
      .map((item) => parseConversationItem(item))
      .filter((item): item is GitHubPullRequestConversationItem => Boolean(item))
  };
}

function parseUnresolvedConversationPages(
  payload: unknown
): Pick<
  GitHubPullRequestSummary,
  | "threadCount"
  | "unresolvedConversationCount"
  | "unresolvedConversationUpdatedAt"
  | "unresolvedConversationItems"
> {
  const pages = Array.isArray(payload) ? payload : [payload];
  const parsedPages = pages.map((page) => parseReviewThreadPage(page));
  const unresolvedConversationItems = parsedPages
    .flatMap((page) => page.items)
    .sort((left, right) => compareOptionalTimestamps(left.updatedAt, right.updatedAt));
  const threadCount = parsedPages.find((page) => page.threadCount !== undefined)?.threadCount;

  return {
    ...(threadCount !== undefined ? { threadCount } : {}),
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
          "title",
          "state",
          "isDraft",
          "updatedAt",
          "headRefName",
          "baseRefName",
          "headRefOid",
          "baseRefOid",
          "changedFiles",
          "mergeable",
          "mergeStateStatus",
          "reviewDecision",
          "statusCheckRollup",
          "comments",
          "latestReviews",
          "files"
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
        if (/no (required )?checks reported/i.test(combinedOutput)) {
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
