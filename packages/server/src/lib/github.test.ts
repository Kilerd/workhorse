import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

describe("GhCliPullRequestProvider", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("loads changed files when fetching an open pull request", async () => {
    execFileMock.mockImplementation((file, args, options, callback) => {
      if (args[0] === "pr" && args[1] === "list") {
        callback(
          null,
          {
            stdout: JSON.stringify([
              {
                number: 42,
                url: "https://github.com/acme/widgets/pull/42",
                headRefName: "feature/review-files",
                baseRefName: "main",
                headRefOid: "head-sha",
                baseRefOid: "base-sha",
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN"
              }
            ]),
            stderr: ""
          }
        );
        return;
      }

      if (args[0] === "pr" && args[1] === "view") {
        callback(
          null,
          {
            stdout: JSON.stringify({
              number: 42,
              url: "https://github.com/acme/widgets/pull/42",
              title: "Refine review task cards",
              state: "OPEN",
              isDraft: false,
              updatedAt: "2026-04-02T09:20:00.000Z",
              headRefName: "feature/review-files",
              baseRefName: "main",
              headRefOid: "head-sha",
              baseRefOid: "base-sha",
              changedFiles: 2,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              reviewDecision: "APPROVED",
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: {
                  nodes: [
                    {
                      state: "SUCCESS"
                    },
                    {
                      state: "SUCCESS"
                    },
                    {
                      state: "SKIPPED"
                    }
                  ]
                }
              },
              comments: [],
              latestReviews: [
                {
                  author: {
                    login: "reviewer"
                  },
                  body: "Looks good to me.",
                  state: "APPROVED",
                  submittedAt: "2026-04-02T09:15:00.000Z",
                  updatedAt: "2026-04-02T09:15:00.000Z",
                  url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1"
                }
              ],
              files: [
                {
                  path: "packages/server/src/lib/github.ts",
                  additions: 12,
                  deletions: 4
                },
                {
                  path: "packages/web/src/components/TaskDetailsPanel.tsx",
                  additions: 28,
                  deletions: 1
                }
              ]
            }),
            stderr: ""
          }
        );
        return;
      }

      if (args[0] === "api" && args[1] === "graphql") {
        callback(null, {
          stdout: JSON.stringify([
            {
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      totalCount: 0,
                      nodes: []
                    }
                  }
                }
              }
            }
          ]),
          stderr: ""
        });
        return;
      }

      callback(new Error(`Unexpected gh invocation: ${String(args.join(" "))}`));
    });

    const { GhCliPullRequestProvider } = await import("./github.js");
    const provider = new GhCliPullRequestProvider();

    await expect(
      provider.findOpenPullRequest("Acme/widgets", "feature/review-files")
    ).resolves.toEqual({
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      headRef: "feature/review-files",
      baseRef: "main",
      title: "Refine review task cards",
      state: "OPEN",
      isDraft: false,
      headSha: "head-sha",
      baseSha: "base-sha",
      updatedAt: "2026-04-02T09:20:00.000Z",
      changedFiles: 2,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollupState: "SUCCESS",
      reviewCount: 1,
      approvalCount: 1,
      statusChecks: {
        total: 3,
        passed: 2,
        failed: 0,
        pending: 0,
        skipped: 1
      },
      feedbackCount: 1,
      feedbackUpdatedAt: "2026-04-02T09:15:00.000Z",
      feedbackItems: [
        {
          source: "review",
          author: "reviewer",
          body: "Looks good to me.",
          url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
          state: "APPROVED",
          createdAt: "2026-04-02T09:15:00.000Z",
          updatedAt: "2026-04-02T09:15:00.000Z"
        }
      ],
      threadCount: 0,
      unresolvedConversationCount: 0,
      unresolvedConversationUpdatedAt: undefined,
      unresolvedConversationItems: [],
      files: [
        {
          path: "packages/server/src/lib/github.ts",
          additions: 12,
          deletions: 4
        },
        {
          path: "packages/web/src/components/TaskDetailsPanel.tsx",
          additions: 28,
          deletions: 1
        }
      ]
    });

    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "gh",
      [
        "pr",
        "view",
        "--repo",
        "acme/widgets",
        "42",
        "--json",
        "number,url,title,state,isDraft,updatedAt,headRefName,baseRefName,headRefOid,baseRefOid,changedFiles,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,comments,latestReviews,files"
      ],
      expect.objectContaining({
        encoding: "utf8"
      }),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      "gh",
      [
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        "owner=acme",
        "-f",
        "name=widgets",
        "-F",
        "number=42",
        "-f",
        expect.stringContaining("reviewThreads(first: 100")
      ],
      expect.objectContaining({
        encoding: "utf8"
      }),
      expect.any(Function)
    );
  });

  it.each([
    "no checks reported on the 'feature' branch",
    "no required checks reported on the 'feature' branch"
  ])("treats '%s' as no required checks", async (stderr) => {
    execFileMock.mockImplementation((file, args, options, callback) => {
      callback(Object.assign(new Error("no checks reported"), {
        code: 1,
        stdout: "",
        stderr
      }));
    });

    const { GhCliPullRequestProvider } = await import("./github.js");
    const provider = new GhCliPullRequestProvider();

    await expect(provider.listRequiredChecks("Kilerd/workhorse", 13)).resolves.toEqual([]);
    expect(execFileMock).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "checks",
        "--repo",
        "kilerd/workhorse",
        "13",
        "--required",
        "--json",
        "bucket,state,name,link"
      ],
      expect.objectContaining({
        encoding: "utf8"
      }),
      expect.any(Function)
    );
  });

  it("loads unresolved review conversations when viewing an open pull request", async () => {
    execFileMock.mockImplementation((file, args, options, callback) => {
      if (args[0] === "pr" && args[1] === "list") {
        callback(null, {
          stdout: JSON.stringify([
            {
              number: 13,
              url: "https://github.com/kilerd/workhorse/pull/13",
              headRefName: "feature/unresolved-thread",
              baseRefName: "main",
              headRefOid: "headsha",
              baseRefOid: "basesha",
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN"
            }
          ]),
          stderr: ""
        });
        return;
      }

      if (args[0] === "pr" && args[1] === "view") {
        callback(null, {
          stdout: JSON.stringify({
            number: 13,
            url: "https://github.com/kilerd/workhorse/pull/13",
            headRefName: "feature/unresolved-thread",
            baseRefName: "main",
            headRefOid: "headsha",
            baseRefOid: "basesha",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: "CHANGES_REQUESTED",
            statusCheckRollup: {
              state: "SUCCESS"
            },
            comments: [],
            latestReviews: []
          }),
          stderr: ""
        });
        return;
      }

      if (args[0] === "api" && args[1] === "graphql") {
        callback(null, {
          stdout: JSON.stringify([
            {
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      totalCount: 1,
                      nodes: [
                        {
                          id: "thread-1",
                          isResolved: false,
                          isOutdated: false,
                          path: "src/app.ts",
                          line: 42,
                          leadingComment: {
                            nodes: [
                              {
                                author: {
                                  login: "reviewer"
                                },
                                body: "Please rename this helper.",
                                createdAt: "2026-04-02T10:00:00.000Z",
                                updatedAt: "2026-04-02T10:00:00.000Z",
                                url: "https://github.com/kilerd/workhorse/pull/13#discussion_r1"
                              }
                            ]
                          },
                          latestComment: {
                            nodes: [
                              {
                                author: {
                                  login: "reviewer"
                                },
                                body: "Please rename this helper.",
                                createdAt: "2026-04-02T10:00:00.000Z",
                                updatedAt: "2026-04-02T10:05:00.000Z",
                                url: "https://github.com/kilerd/workhorse/pull/13#discussion_r1"
                              }
                            ]
                          }
                        }
                      ],
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null
                      }
                    }
                  }
                }
              }
            }
          ]),
          stderr: ""
        });
        return;
      }

      callback(new Error(`Unexpected command: ${args.join(" ")}`));
    });

    const { GhCliPullRequestProvider } = await import("./github.js");
    const provider = new GhCliPullRequestProvider();

    await expect(
      provider.findOpenPullRequest("Kilerd/workhorse", "feature/unresolved-thread")
    ).resolves.toMatchObject({
      number: 13,
      threadCount: 1,
      unresolvedConversationCount: 1,
      unresolvedConversationUpdatedAt: "2026-04-02T10:05:00.000Z",
      unresolvedConversationItems: [
        expect.objectContaining({
          id: "thread-1",
          author: "reviewer",
          path: "src/app.ts",
          line: 42
        })
      ]
    });

    expect(execFileMock).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining([
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        "owner=kilerd",
        "-f",
        "name=workhorse"
      ]),
      expect.objectContaining({
        encoding: "utf8"
      }),
      expect.any(Function)
    );
  });

  it("posts PR comments via gh pr comment", async () => {
    execFileMock.mockImplementation((file, args, options, callback) => {
      callback(null, {
        stdout: "",
        stderr: ""
      });
    });

    const { GhCliPullRequestProvider } = await import("./github.js");
    const provider = new GhCliPullRequestProvider();

    await expect(
      provider.addPullRequestComment("Kilerd/workhorse", 13, "Checking unresolved threads.")
    ).resolves.toBeUndefined();

    expect(execFileMock).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "comment",
        "--repo",
        "kilerd/workhorse",
        "13",
        "--body",
        "Checking unresolved threads."
      ],
      expect.objectContaining({
        encoding: "utf8"
      }),
      expect.any(Function)
    );
  });
});
