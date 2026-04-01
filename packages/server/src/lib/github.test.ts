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
});
