import type { Run, Task } from "@workhorse/contracts";

import { truncateTeamMessagePayload } from "./team-coordinator-service.js";

const MAX_DIFF_LINES = 50;
const DIFF_TRUNCATED_NOTE = "\n...[diff truncated to 50 lines]";

// Maximum bytes reserved for the diff_summary string value in the artifact JSON.
// Leaves ample headroom for other fields (files_changed, pr_url, test_results) and
// JSON structure overhead so the full serialized payload stays under the 10KB message limit.
const MAX_DIFF_SUMMARY_BYTES = 8 * 1024;
const DIFF_SUMMARY_OVERFLOW_MARKER = "\n...[truncated]";

export interface SubtaskArtifactParams {
  diff: string;
  pullRequestUrl?: string;
}

export function buildSubtaskStatusPayload(task: Task, run: Run): string {
  const outcome = run.status === "succeeded" ? "completed" : "failed";
  return `Subtask '${task.title}' ${outcome}.`;
}

export function buildSubtaskArtifactPayload(params: SubtaskArtifactParams): string {
  const filesChanged = extractFilesChanged(params.diff);
  const diffSummary = fitDiffSummary(summarizeDiff(params.diff));
  // Serialize directly — the diff_summary is already trimmed to fit so the
  // resulting JSON is guaranteed to be under 10KB. We do NOT use
  // truncateTeamMessagePayload here because byte-level string truncation
  // of a serialized JSON produces invalid JSON.
  return JSON.stringify({
    files_changed: filesChanged,
    diff_summary: diffSummary,
    test_results: null,
    pr_url: params.pullRequestUrl ?? null
  });
}

function fitDiffSummary(summary: string): string {
  if (Buffer.byteLength(summary, "utf8") <= MAX_DIFF_SUMMARY_BYTES) {
    return summary;
  }
  const markerBytes = Buffer.byteLength(DIFF_SUMMARY_OVERFLOW_MARKER, "utf8");
  const head = trimStringToBytes(summary, MAX_DIFF_SUMMARY_BYTES - markerBytes);
  return head + DIFF_SUMMARY_OVERFLOW_MARKER;
}

function trimStringToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    bytes += charBytes;
    end += char.length;
  }
  return value.slice(0, end);
}

function extractFilesChanged(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (match?.[1]) {
      files.push(match[1]);
    }
  }
  return files;
}

function summarizeDiff(diff: string): string {
  if (!diff.trim()) {
    return "";
  }
  const lines = diff.split("\n");
  if (lines.length <= MAX_DIFF_LINES) {
    return diff.trimEnd();
  }
  return lines.slice(0, MAX_DIFF_LINES).join("\n") + DIFF_TRUNCATED_NOTE;
}
