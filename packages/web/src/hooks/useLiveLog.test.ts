import { describe, expect, it } from "vitest";
import type { RunFinishedEvent, RunOutputEvent } from "@workhorse/contracts";

import { appendLiveLogEntry, clearLiveLogRun, type LiveLogByRunId } from "./useLiveLog";

function createRunOutputEvent(runId: string, entryId: string): RunOutputEvent {
  return {
    type: "run.output",
    taskId: "task-1",
    runId,
    entry: {
      id: entryId,
      runId,
      timestamp: "2026-04-08T00:00:00.000Z",
      stream: "stdout",
      kind: "text",
      text: `${entryId}\n`
    }
  };
}

describe("useLiveLog helpers", () => {
  it("appends run output entries under their run id", () => {
    const first = appendLiveLogEntry({}, createRunOutputEvent("run-1", "entry-1"));
    const second = appendLiveLogEntry(first, createRunOutputEvent("run-1", "entry-2"));

    expect(second).toEqual({
      "run-1": [
        expect.objectContaining({ id: "entry-1" }),
        expect.objectContaining({ id: "entry-2" })
      ]
    });
  });

  it("ignores non-output events", () => {
    const current: LiveLogByRunId = {
      "run-1": [createRunOutputEvent("run-1", "entry-1").entry]
    };
    const event: RunFinishedEvent = {
      type: "run.finished",
      taskId: "task-1",
      run: {
        id: "run-1",
        taskId: "task-1",
        status: "succeeded",
        runnerType: "codex",
        command: "codex",
        startedAt: "2026-04-08T00:00:00.000Z",
        endedAt: "2026-04-08T00:01:00.000Z",
        logFile: "/tmp/run-1.log"
      },
      task: {
        id: "task-1",
        title: "Task",
        description: "",
        workspaceId: "workspace-1",
        column: "review",
        runnerType: "codex",
        runnerConfig: {
          type: "codex",
          prompt: "Fix the bug"
        },
        order: 1024,
        worktree: {
          path: "/tmp/worktree",
          branchName: "task-1",
          baseRef: "main",
          status: "ready"
        },
        dependencies: [],
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:01:00.000Z"
      }
    };

    expect(appendLiveLogEntry(current, event)).toBe(current);
  });

  it("clears finished runs without touching the remaining live buffer", () => {
    const current = ["run-1", "run-2", "run-3"].reduce<LiveLogByRunId>((acc, runId, index) => {
      return appendLiveLogEntry(acc, createRunOutputEvent(runId, `entry-${index + 1}`));
    }, {});

    const afterFirstCleanup = clearLiveLogRun(current, "run-1");
    const afterSecondCleanup = clearLiveLogRun(afterFirstCleanup, "run-2");

    expect(afterSecondCleanup).toEqual({
      "run-3": [expect.objectContaining({ id: "entry-3" })]
    });
  });

  it("returns the original object when clearing an unknown run", () => {
    const current: LiveLogByRunId = {
      "run-1": [createRunOutputEvent("run-1", "entry-1").entry]
    };

    expect(clearLiveLogRun(current, "missing-run")).toBe(current);
  });
});
