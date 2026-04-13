import { describe, expect, it } from "vitest";

import { buildSubtaskArtifactPayload, buildSubtaskStatusPayload } from "./team-subtask-service.js";

function makeTask(overrides: Partial<{ id: string; title: string }> = {}) {
  return {
    id: "task-1",
    title: "Implement auth module",
    description: "",
    workspaceId: "ws-1",
    column: "done" as const,
    order: 0,
    runnerType: "claude" as const,
    runnerConfig: { type: "claude" as const, prompt: "" },
    dependencies: [],
    worktree: { baseRef: "origin/main", branchName: "team/t1/impl", status: "ready" as const },
    teamId: "team-1",
    parentTaskId: "parent-1",
    teamAgentId: "agent-1",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeRun(status: "succeeded" | "failed") {
  return {
    id: "run-1",
    taskId: "task-1",
    status,
    runnerType: "claude" as const,
    command: "claude",
    startedAt: "2024-01-01T00:00:00.000Z"
  };
}

describe("buildSubtaskStatusPayload", () => {
  it("returns completed message for succeeded run", () => {
    const task = makeTask({ title: "Build feature X" });
    const run = makeRun("succeeded");
    expect(buildSubtaskStatusPayload(task, run)).toBe("Subtask 'Build feature X' completed.");
  });

  it("returns failed message for failed run", () => {
    const task = makeTask({ title: "Build feature X" });
    const run = makeRun("failed");
    expect(buildSubtaskStatusPayload(task, run)).toBe("Subtask 'Build feature X' failed.");
  });
});

describe("buildSubtaskArtifactPayload", () => {
  it("extracts files changed from diff", () => {
    const diff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "index abc..def 100644",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,1 +1,2 @@",
      "+export function login() {}"
    ].join("\n");

    const payload = buildSubtaskArtifactPayload({ diff });
    const parsed = JSON.parse(payload) as { files_changed: string[] };
    expect(parsed.files_changed).toEqual(["src/auth.ts"]);
  });

  it("includes pr_url when provided", () => {
    const payload = buildSubtaskArtifactPayload({
      diff: "",
      pullRequestUrl: "https://github.com/org/repo/pull/42"
    });
    const parsed = JSON.parse(payload) as { pr_url: string };
    expect(parsed.pr_url).toBe("https://github.com/org/repo/pull/42");
  });

  it("sets pr_url to null when not provided", () => {
    const payload = buildSubtaskArtifactPayload({ diff: "" });
    const parsed = JSON.parse(payload) as { pr_url: null };
    expect(parsed.pr_url).toBeNull();
  });

  it("always includes test_results field as null", () => {
    const payload = buildSubtaskArtifactPayload({ diff: "" });
    const parsed = JSON.parse(payload) as { test_results: null };
    expect(parsed.test_results).toBeNull();
  });

  it("returns empty diff_summary for empty diff", () => {
    const payload = buildSubtaskArtifactPayload({ diff: "" });
    const parsed = JSON.parse(payload) as { diff_summary: string };
    expect(parsed.diff_summary).toBe("");
  });

  it("truncates diff at 50 lines", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `+line ${i}`);
    const diff = lines.join("\n");
    const payload = buildSubtaskArtifactPayload({ diff });
    const parsed = JSON.parse(payload) as { diff_summary: string };
    expect(parsed.diff_summary).toContain("...[diff truncated to 50 lines]");
    const summaryLines = parsed.diff_summary.split("\n");
    // 50 content lines + 1 truncation note line
    expect(summaryLines.length).toBe(51);
  });

  it("does not truncate diff at exactly 50 lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `+line ${i}`);
    const diff = lines.join("\n");
    const payload = buildSubtaskArtifactPayload({ diff });
    const parsed = JSON.parse(payload) as { diff_summary: string };
    expect(parsed.diff_summary).not.toContain("truncated");
  });

  it("applies 10KB truncation to oversized payload", () => {
    // Generate a very large diff to exceed 10KB after JSON serialization
    const bigLine = "+".padEnd(200, "x");
    const lines = Array.from({ length: 10 }, () => bigLine);
    const diff = lines.join("\n");
    // Generate many files
    const manyFiles = Array.from({ length: 200 }, (_, i) => `file${i}.ts`);
    const bigDiff =
      manyFiles.map((f) => `diff --git a/${f} b/${f}\n${diff}`).join("\n");

    const payload = buildSubtaskArtifactPayload({ diff: bigDiff });
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(10 * 1024);
    expect(payload).toContain("...[truncated]");
  });
});
