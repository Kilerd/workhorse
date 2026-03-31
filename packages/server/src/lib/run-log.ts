import type { RunLogEntry, RunLogKind, RunLogStream } from "@workhorse/contracts";

import { createId } from "./id.js";

export interface RunLogEntryInput {
  kind: RunLogKind;
  text: string;
  stream: RunLogStream;
  title?: string;
  source?: string;
  metadata?: Record<string, string>;
}

export function createRunLogEntry(
  runId: string,
  input: RunLogEntryInput,
  timestamp = new Date().toISOString()
): RunLogEntry {
  return {
    id: createId(),
    runId,
    timestamp,
    kind: input.kind,
    stream: input.stream,
    text: input.text,
    title: input.title,
    source: input.source,
    metadata: input.metadata
  };
}

export function serializeRunLogEntry(entry: RunLogEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

export function parseRunLogEntries(
  runId: string,
  raw: string
): RunLogEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 0) {
    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter(isRunLogEntry);

    if (parsed.length === lines.length) {
      return parsed;
    }
  }

  return [
    createRunLogEntry(
      runId,
      {
        kind: "text",
        stream: "stdout",
        text: raw
      },
      new Date(0).toISOString()
    )
  ];
}

function isRunLogEntry(value: unknown): value is RunLogEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RunLogEntry>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.runId === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.stream === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.text === "string"
  );
}
