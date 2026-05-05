import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  WorkspaceHarness,
  WorkspaceHarnessFile,
  WorkspaceHarnessFileId
} from "@workhorse/contracts";

const MAX_CONTENT_BYTES = 256 * 1024;

interface HarnessFileSpec {
  id: WorkspaceHarnessFileId;
  relativePath: string;
}

const HARNESS_FILES: readonly HarnessFileSpec[] = [
  { id: "claude-md", relativePath: "CLAUDE.md" },
  { id: "agents-md", relativePath: "AGENTS.md" }
];

export async function readWorkspaceHarness(
  rootPath: string
): Promise<WorkspaceHarness> {
  const files = await Promise.all(
    HARNESS_FILES.map((spec) => readHarnessFile(rootPath, spec))
  );
  return { files };
}

async function readHarnessFile(
  rootPath: string,
  spec: HarnessFileSpec
): Promise<WorkspaceHarnessFile> {
  const missing: WorkspaceHarnessFile = {
    id: spec.id,
    relativePath: spec.relativePath,
    exists: false
  };

  let resolvedRoot: string;
  try {
    resolvedRoot = await fs.realpath(rootPath);
  } catch {
    return missing;
  }

  const target = path.resolve(resolvedRoot, spec.relativePath);

  let resolvedTarget: string;
  try {
    resolvedTarget = await fs.realpath(target);
  } catch {
    return missing;
  }

  if (!isWithin(resolvedRoot, resolvedTarget)) {
    return missing;
  }

  let stat;
  try {
    stat = await fs.stat(resolvedTarget);
  } catch {
    return missing;
  }

  if (!stat.isFile()) {
    return missing;
  }

  const buffer = await fs.readFile(resolvedTarget);
  const truncated = buffer.byteLength > MAX_CONTENT_BYTES;
  const slice = truncated ? buffer.subarray(0, MAX_CONTENT_BYTES) : buffer;

  return {
    id: spec.id,
    relativePath: spec.relativePath,
    exists: true,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    content: slice.toString("utf8"),
    truncated
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(rootWithSep);
}
