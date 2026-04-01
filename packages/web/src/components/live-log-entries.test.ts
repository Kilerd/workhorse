import { describe, expect, it } from "vitest";
import type { RunLogEntry } from "@workhorse/contracts";

import {
  getToolStatus,
  isCommandExecutionEntry,
  normalizeToolTitle,
  partitionLiveLogEntries,
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
    expect(toolEntry).toBeDefined();
    expect(outputEntry).toBeDefined();
    if (!toolEntry || !outputEntry) {
      throw new Error("Expected aggregated tool entries");
    }

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

  it("splits entries into live stream, active cards, archives and system notices", () => {
    const groups = partitionLiveLogEntries(
      prepareLiveLogEntries([
        makeEntry({
          id: "stdout",
          kind: "text",
          stream: "stdout",
          title: "Shell output",
          text: "running tests\n"
        }),
        makeEntry({
          id: "tool-active",
          timestamp: "2026-04-01T01:47:32.000Z",
          title: "File Search started",
          text: "searching task logs",
          metadata: {
            itemType: "fileSearch",
            phase: "started",
            status: "inProgress"
          }
        }),
        makeEntry({
          id: "tool-done",
          timestamp: "2026-04-01T01:47:33.000Z",
          title: "Command Execution completed",
          text: "npm run build\nexit code: 0",
          metadata: {
            itemType: "commandExecution",
            phase: "completed",
            status: "completed",
            exitCode: "0"
          }
        }),
        makeEntry({
          id: "plan",
          timestamp: "2026-04-01T01:47:34.000Z",
          kind: "plan",
          stream: "system",
          title: "Plan updated",
          text: "1. Inspect logs\n2. Improve UI"
        }),
        makeEntry({
          id: "system",
          timestamp: "2026-04-01T01:47:35.000Z",
          kind: "system",
          stream: "system",
          title: "Codex ACP",
          text: "heartbeat\n"
        })
      ])
    );

    expect(groups.streamEntries.map((entry) => entry.id)).toEqual(["stdout"]);
    expect(groups.activeEntries.map((entry) => entry.id)).toEqual(["tool-active", "plan"]);
    expect(groups.completedToolEntries.map((entry) => entry.id)).toEqual(["tool-done"]);
    expect(groups.systemEntries.map((entry) => entry.id)).toEqual(["system"]);
  });

  it("keeps only the latest plan card in the active lane", () => {
    const groups = partitionLiveLogEntries(
      prepareLiveLogEntries([
        makeEntry({
          id: "plan-start-1",
          kind: "plan",
          stream: "system",
          title: "Plan started",
          text: "Planning started.",
          metadata: {
            itemType: "reasoning",
            phase: "started",
            itemId: "reason-1",
            groupId: "item:turn-1:reason-1"
          }
        }),
        makeEntry({
          id: "plan-start-2",
          timestamp: "2026-04-01T01:47:32.000Z",
          kind: "plan",
          stream: "system",
          title: "Plan started",
          text: "Planning started.",
          metadata: {
            itemType: "reasoning",
            phase: "started",
            itemId: "reason-2",
            groupId: "item:turn-1:reason-2"
          }
        }),
        makeEntry({
          id: "tool-active",
          timestamp: "2026-04-01T01:47:33.000Z",
          title: "Command Execution started",
          text: "npm run build",
          metadata: {
            itemType: "commandExecution",
            phase: "started",
            status: "inProgress"
          }
        })
      ])
    );

    expect(groups.activeEntries.map((entry) => entry.id)).toEqual([
      "plan-start-2",
      "tool-active"
    ]);
  });
});
