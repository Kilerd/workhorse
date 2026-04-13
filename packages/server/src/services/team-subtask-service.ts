import type { Run, Task } from "@workhorse/contracts";

import { truncateTeamMessagePayload } from "./team-coordinator-service.js";

const MAX_DIFF_LINES = 50;
const DIFF_TRUNCATED_NOTE = "\n...[diff truncated to 50 lines]";

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
  const diffSummary = summarizeDiff(params.diff);
  const artifact = {
    files_changed: filesChanged,
    diff_summary: diffSummary,
    pr_url: params.pullRequestUrl ?? null
  };
  return truncateTeamMessagePayload(JSON.stringify(artifact));
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
