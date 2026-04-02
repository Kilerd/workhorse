import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

describe("GhCliPullRequestProvider", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("treats 'no checks reported' as no required checks", async () => {
    execFileMock.mockImplementation((file, args, options, callback) => {
      callback(Object.assign(new Error("no checks reported"), {
        code: 1,
        stdout: "",
        stderr: "no checks reported on the 'feature' branch"
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
