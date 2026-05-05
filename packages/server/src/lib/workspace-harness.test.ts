import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWorkspaceHarness } from "./workspace-harness.js";

describe("readWorkspaceHarness", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-harness-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("reports both files missing when nothing is on disk", async () => {
    const harness = await readWorkspaceHarness(tempRoot);
    expect(harness.files).toHaveLength(2);
    expect(harness.files.every((file) => file.exists === false)).toBe(true);
    expect(harness.files.map((file) => file.id).sort()).toEqual([
      "agents-md",
      "claude-md"
    ]);
  });

  it("returns CLAUDE.md content when only that file exists", async () => {
    const claudeContent = "# Claude\n\nProject rules.\n";
    await fs.writeFile(path.join(tempRoot, "CLAUDE.md"), claudeContent, "utf8");

    const harness = await readWorkspaceHarness(tempRoot);
    const claude = harness.files.find((file) => file.id === "claude-md");
    const agents = harness.files.find((file) => file.id === "agents-md");

    expect(claude?.exists).toBe(true);
    expect(claude?.content).toBe(claudeContent);
    expect(claude?.sizeBytes).toBe(Buffer.byteLength(claudeContent, "utf8"));
    expect(claude?.truncated).toBe(false);
    expect(claude?.modifiedAt).toMatch(/T.*Z$/);
    expect(agents?.exists).toBe(false);
    expect(agents?.content).toBeUndefined();
  });

  it("truncates files larger than 256 KB and flags them", async () => {
    const big = "x".repeat(512 * 1024);
    await fs.writeFile(path.join(tempRoot, "AGENTS.md"), big, "utf8");

    const harness = await readWorkspaceHarness(tempRoot);
    const agents = harness.files.find((file) => file.id === "agents-md");

    expect(agents?.exists).toBe(true);
    expect(agents?.truncated).toBe(true);
    expect(agents?.content?.length).toBe(256 * 1024);
    expect(agents?.sizeBytes).toBe(big.length);
  });

  it("returns missing when the rootPath itself does not exist", async () => {
    const harness = await readWorkspaceHarness(
      path.join(tempRoot, "does-not-exist")
    );
    expect(harness.files.every((file) => file.exists === false)).toBe(true);
  });

  it("rejects symlinks pointing outside the workspace root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
    try {
      const outsideFile = path.join(outside, "CLAUDE.md");
      await fs.writeFile(outsideFile, "leaked", "utf8");
      await fs.symlink(outsideFile, path.join(tempRoot, "CLAUDE.md"));

      const harness = await readWorkspaceHarness(tempRoot);
      const claude = harness.files.find((file) => file.id === "claude-md");
      expect(claude?.exists).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
