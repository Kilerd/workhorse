import { describe, expect, it } from "vitest";
import type { RunLogEntry } from "@workhorse/contracts";

import {
  buildLiveLogStreamItems,
  findStickyPlanEntry,
  getToolStatus,
  groupLiveLogStreamItems,
  isCommandExecutionEntry,
  normalizeToolTitle,
  parseStickyPlanContent,
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

  it("merges status lifecycle entries into a single stream item", () => {
    const entries = prepareLiveLogEntries([
      makeEntry({
        id: "status-started",
        kind: "status",
        title: "File Change",
        text: "status: inProgress",
        metadata: {
          groupId: "item:turn-1:item-2",
          itemId: "item-2",
          itemType: "fileChange",
          phase: "started",
          turnId: "turn-1",
          threadId: "thread-1"
        }
      }),
      makeEntry({
        id: "agent",
        timestamp: "2026-04-01T01:47:32.000Z",
        kind: "agent",
        stream: "stdout",
        title: "Agent output",
        text: "Thinking..."
      }),
      makeEntry({
        id: "status-completed",
        timestamp: "2026-04-01T01:47:33.000Z",
        kind: "status",
        title: "File Change",
        text: "status: completed",
        metadata: {
          groupId: "item:turn-1:item-2",
          itemId: "item-2",
          itemType: "fileChange",
          phase: "completed",
          turnId: "turn-1",
          threadId: "thread-1"
        }
      })
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: "status-started",
      kind: "status",
      title: "File Change",
      text: "status: completed",
      metadata: {
        itemType: "fileChange",
        phase: "completed"
      }
    });
    expect(getToolStatus(entries[0]!)).toEqual({
      label: "Completed",
      tone: "completed"
    });
    expect(entries[1]).toMatchObject({
      id: "agent"
    });
  });

  it("routes the latest meaningful plan entry to the sticky plan panel", () => {
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
      "system"
    ]);
    expect(groups.stickyPlanEntry?.id).toBe("plan");
  });

  it("filters boilerplate plan entries from the stream without creating a sticky plan", () => {
    const groups = partitionLiveLogEntries(
      prepareLiveLogEntries([
        makeEntry({
          id: "plan-start",
          kind: "plan",
          stream: "system",
          title: "Plan started",
          text: "Planning started."
        }),
        makeEntry({
          id: "status",
          timestamp: "2026-04-01T01:47:35.000Z",
          kind: "status",
          stream: "system",
          title: "File Change",
          text: "status: inProgress"
        })
      ])
    );

    expect(groups.stickyPlanEntry).toBeNull();
    expect(groups.streamEntries.map((entry) => entry.id)).toEqual(["status"]);
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

  it("parses sticky plan checklist content", () => {
    expect(
      parseStickyPlanContent(`# Plan

1. Inspect the code
- [x] Add tests
- [ ] Verify build`)
    ).toEqual({
      summary: null,
      items: [
        { text: "Inspect the code", done: false },
        { text: "Add tests", done: true },
        { text: "Verify build", done: false }
      ],
      body: null
    });
  });

  it("finds the latest non-boilerplate plan entry", () => {
    const entries = prepareLiveLogEntries([
      makeEntry({
        id: "plan-start",
        kind: "plan",
        stream: "system",
        title: "Plan started",
        text: "Planning started."
      }),
      makeEntry({
        id: "plan-update",
        timestamp: "2026-04-01T01:47:35.000Z",
        kind: "plan",
        stream: "system",
        title: "Plan updated",
        text: "1. Inspect logs\n2. Tighten UI"
      })
    ]);

    expect(findStickyPlanEntry(entries)?.id).toBe("plan-update");
  });

  it("groups nearby completed command executions into a single stream item", () => {
    const streamItems = groupLiveLogStreamItems(
      buildLiveLogStreamItems(
        prepareLiveLogEntries([
          makeEntry({
            id: "command-1",
            title: "Command Execution completed",
            text: "sed -n '1,260p' packages/web/src/components/LiveLog.tsx",
            metadata: {
              itemType: "commandExecution",
              phase: "completed",
              status: "completed",
              groupId: "item:turn-1:command-1"
            }
          }),
          makeEntry({
            id: "command-2",
            timestamp: "2026-04-01T01:47:38.000Z",
            title: "Command Execution completed",
            text: "sed -n '1,260p' packages/web/src/components/live-log-entries.ts",
            metadata: {
              itemType: "commandExecution",
              phase: "completed",
              status: "completed",
              groupId: "item:turn-1:command-2"
            }
          }),
          makeEntry({
            id: "command-3",
            timestamp: "2026-04-01T01:47:49.000Z",
            title: "Command Execution completed",
            text: "sed -n '1,260p' packages/server/src/lib/run-log.ts",
            metadata: {
              itemType: "commandExecution",
              phase: "completed",
              status: "completed",
              groupId: "item:turn-1:command-3"
            }
          }),
          makeEntry({
            id: "agent",
            timestamp: "2026-04-01T01:47:52.000Z",
            kind: "agent",
            stream: "stdout",
            title: "Agent output",
            text: "Inspected the log stream."
          })
        ])
      )
    );

    expect(streamItems).toHaveLength(2);
    expect(streamItems[0]).toMatchObject({
      type: "command_execution_group",
      items: [
        { entry: { id: "command-1" } },
        { entry: { id: "command-2" } },
        { entry: { id: "command-3" } }
      ]
    });
    expect(streamItems[1]).toMatchObject({
      type: "entry",
      entry: { id: "agent" }
    });
  });

  it("keeps in-progress command executions expanded as individual items", () => {
    const streamItems = groupLiveLogStreamItems(
      buildLiveLogStreamItems(
        prepareLiveLogEntries([
          makeEntry({
            id: "command-1",
            title: "Command Execution started",
            text: "npm run build",
            metadata: {
              itemType: "commandExecution",
              phase: "started",
              status: "inProgress"
            }
          }),
          makeEntry({
            id: "command-2",
            timestamp: "2026-04-01T01:47:32.000Z",
            title: "Command Execution started",
            text: "npm run test",
            metadata: {
              itemType: "commandExecution",
              phase: "started",
              status: "inProgress"
            }
          })
        ])
      )
    );

    expect(streamItems).toHaveLength(2);
    expect(streamItems[0]).toMatchObject({
      type: "tool",
      entry: { id: "command-1" }
    });
    expect(streamItems[1]).toMatchObject({
      type: "tool",
      entry: { id: "command-2" }
    });
  });
});
