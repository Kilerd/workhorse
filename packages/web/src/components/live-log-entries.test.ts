import { describe, expect, it } from "vitest";
import type { RunLogEntry } from "@workhorse/contracts";

import {
  buildLiveLogStreamItems,
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

  it("keeps tool, plan and system events in the output stream", () => {
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

    expect(groups.streamEntries.map((entry) => entry.id)).toEqual([
      "stdout",
      "tool-active",
      "tool-done",
      "plan",
      "system"
    ]);
  });

  it("attaches following tool output blocks to the preceding tool entry in stream order", () => {
    const streamItems = buildLiveLogStreamItems(
      prepareLiveLogEntries([
        makeEntry({
          id: "tool",
          title: "Command Execution completed",
          text: "gh auth status",
          metadata: {
            itemType: "commandExecution",
            phase: "completed",
            status: "completed"
          }
        }),
        makeEntry({
          id: "tool-output-stdout",
          timestamp: "2026-04-01T01:47:32.000Z",
          kind: "tool_output",
          stream: "stdout",
          title: "Tool output",
          text: "github.com\n  Logged in\n"
        }),
        makeEntry({
          id: "tool-output-stderr",
          timestamp: "2026-04-01T01:47:33.000Z",
          kind: "tool_output",
          stream: "stderr",
          title: "Tool output",
          text: "warning\n"
        }),
        makeEntry({
          id: "agent",
          timestamp: "2026-04-01T01:47:34.000Z",
          kind: "agent",
          stream: "stdout",
          title: "Agent output",
          text: "Done."
        })
      ])
    );

    expect(streamItems).toHaveLength(2);
    expect(streamItems[0]).toMatchObject({
      type: "tool",
      entry: { id: "tool" },
      outputEntries: [{ id: "tool-output-stdout" }, { id: "tool-output-stderr" }]
    });
    expect(streamItems[1]).toMatchObject({
      type: "entry",
      entry: { id: "agent" }
    });
  });

  it("prefers group metadata when attaching tool output to a tool entry", () => {
    const streamItems = buildLiveLogStreamItems(
      prepareLiveLogEntries([
        makeEntry({
          id: "tool-a",
          title: "Command Execution completed",
          text: "first command",
          metadata: {
            itemType: "commandExecution",
            phase: "completed",
            status: "completed",
            groupId: "item:turn-1:item-a"
          }
        }),
        makeEntry({
          id: "tool-b",
          timestamp: "2026-04-01T01:47:32.000Z",
          title: "Command Execution completed",
          text: "second command",
          metadata: {
            itemType: "commandExecution",
            phase: "completed",
            status: "completed",
            groupId: "item:turn-1:item-b"
          }
        }),
        makeEntry({
          id: "tool-b-output",
          timestamp: "2026-04-01T01:47:33.000Z",
          kind: "tool_output",
          stream: "stdout",
          title: "Tool output",
          text: "second output\n",
          metadata: {
            groupId: "item:turn-1:item-b"
          }
        }),
        makeEntry({
          id: "tool-a-output-late",
          timestamp: "2026-04-01T01:47:34.000Z",
          kind: "tool_output",
          stream: "stdout",
          title: "Tool output",
          text: "late first output\n",
          metadata: {
            groupId: "item:turn-1:item-a"
          }
        })
      ])
    );

    expect(streamItems).toHaveLength(2);
    expect(streamItems[0]).toMatchObject({
      type: "tool",
      entry: { id: "tool-a" },
      outputEntries: [{ id: "tool-a-output-late" }]
    });
    expect(streamItems[1]).toMatchObject({
      type: "tool",
      entry: { id: "tool-b" },
      outputEntries: [{ id: "tool-b-output" }]
    });
  });

  it("keeps same-timestamp entries in their original input order", () => {
    const entries = prepareLiveLogEntries([
      makeEntry({
        id: "agent-late",
        timestamp: "2026-04-01T01:47:31.000Z",
        kind: "agent",
        stream: "stdout",
        title: "Agent output",
        text: "later in input"
      }),
      makeEntry({
        id: "agent-earlier",
        timestamp: "2026-04-01T01:47:31.000Z",
        kind: "agent",
        stream: "stdout",
        title: "Agent output",
        text: "still same timestamp",
        metadata: {
          groupId: "agent:turn-1:item-2"
        }
      }),
      makeEntry({
        id: "agent-last",
        timestamp: "2026-04-01T01:47:32.000Z",
        kind: "agent",
        stream: "stdout",
        title: "Agent output",
        text: "last"
      })
    ]);

    expect(entries.map((entry) => entry.id)).toEqual([
      "agent-late",
      "agent-earlier",
      "agent-last"
    ]);
  });
});
