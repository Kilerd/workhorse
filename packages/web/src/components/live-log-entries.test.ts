import { describe, expect, it } from "vitest";
import type { RunLogEntry } from "@workhorse/contracts";

import {
  getToolStatus,
  isCommandExecutionEntry,
  normalizeToolTitle,
  prepareLiveLogEntries
} from "./live-log-entries";

function makeEntry(overrides: Partial<RunLogEntry>): RunLogEntry {
  return {
    id: "entry-1",
    runId: "run-1",
    timestamp: "2026-04-01T01:47:31.000Z",
    stream: "system",
    kind: "tool_call",
    text: "default",
    ...overrides
  };
}

describe("live log entry aggregation", () => {
  it("merges command execution lifecycle entries even when output is interleaved", () => {
    const entries = prepareLiveLogEntries([
      makeEntry({
        id: "tool-started",
        title: "Command Execution started",
        text: "/bin/zsh -lc \"sed -n '200,470p' packages/server/src/runners/codex-acp-runner.ts\"",
        metadata: {
          groupId: "item:turn-1:item-1",
          itemId: "item-1",
          itemType: "commandExecution",
          phase: "started",
          status: "inProgress",
          turnId: "turn-1",
          threadId: "thread-1"
        }
      }),
      makeEntry({
        id: "tool-output",
        timestamp: "2026-04-01T01:47:32.000Z",
        stream: "stdout",
        kind: "tool_output",
        title: "Tool output",
        text: "status\ninProgress\n"
      }),
      makeEntry({
        id: "tool-completed",
        timestamp: "2026-04-01T01:47:33.000Z",
        title: "Command Execution completed",
        text:
          "/bin/zsh -lc \"sed -n '200,470p' packages/server/src/runners/codex-acp-runner.ts\"\nexit code: 0",
        metadata: {
          groupId: "item:turn-1:item-1",
          itemId: "item-1",
          itemType: "commandExecution",
          phase: "completed",
          status: "completed",
          exitCode: "0",
          turnId: "turn-1",
          threadId: "thread-1"
        }
      })
    ]);

    expect(entries).toHaveLength(2);

    const [toolEntry, outputEntry] = entries;
    expect(toolEntry.kind).toBe("tool_call");
    expect(toolEntry.timestamp).toBe("2026-04-01T01:47:33.000Z");
    expect(toolEntry.text).toContain("exit code: 0");
    expect(normalizeToolTitle(toolEntry)).toBe("Command Execution");
    expect(isCommandExecutionEntry(toolEntry)).toBe(true);
    expect(getToolStatus(toolEntry)).toEqual({
      label: "Completed",
      tone: "completed"
    });

    expect(outputEntry.kind).toBe("tool_output");
    expect(outputEntry.text).toBe("status\ninProgress\n");
  });
});
