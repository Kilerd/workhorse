import { describe, expect, it } from "vitest";
import type { Workspace } from "@workhorse/contracts";

import { resolveTaskWorkspaceId } from "./workspace-selection";

const WORKSPACES: Workspace[] = [
  {
    id: "workspace-1",
    name: "Alpha",
    rootPath: "/tmp/alpha",
    isGitRepo: false,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z"
  },
  {
    id: "workspace-2",
    name: "Beta",
    rootPath: "/tmp/beta",
    isGitRepo: true,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z"
  }
];

describe("resolveTaskWorkspaceId", () => {
  it("uses the currently selected workspace when the board is scoped", () => {
    expect(resolveTaskWorkspaceId(WORKSPACES, "workspace-2")).toBe("workspace-2");
  });

  it("falls back to the first workspace when the board is scoped to all", () => {
    expect(resolveTaskWorkspaceId(WORKSPACES, "all")).toBe("workspace-1");
  });

  it("falls back to the first workspace when the selected workspace is missing", () => {
    expect(resolveTaskWorkspaceId(WORKSPACES, "workspace-3")).toBe("workspace-1");
  });

  it("returns an empty string when no workspaces exist", () => {
    expect(resolveTaskWorkspaceId([], "all")).toBe("");
  });
});
