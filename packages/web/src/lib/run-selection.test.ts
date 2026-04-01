import { describe, expect, it } from "vitest";
import type { Run } from "@workhorse/contracts";

import {
  resolveActiveRunId,
  resolveRunSelectionAfterStart,
  resolveViewedRunId
} from "./run-selection";

function makeRun(overrides: Partial<Run>): Run {
  return {
    id: "run-1",
    taskId: "task-1",
    status: "succeeded",
    runnerType: "shell",
    command: "true",
    startedAt: "2026-04-01T01:00:00.000Z",
    logFile: "/tmp/run-1.log",
    ...overrides
  };
}

describe("run selection", () => {
  it("returns the actual active run without being affected by history selection", () => {
    const runs = [
      makeRun({
        id: "run-current",
        status: "running",
        startedAt: "2026-04-01T02:00:00.000Z"
      }),
      makeRun({
        id: "run-previous",
        startedAt: "2026-04-01T01:00:00.000Z"
      })
    ];

    expect(resolveActiveRunId(runs)).toBe("run-current");
  });

  it("keeps the previous run selected when a review task is started again", () => {
    expect(
      resolveRunSelectionAfterStart({
        selectedRunId: null,
        previousLastRunId: "run-previous",
        startedRunId: "run-current"
      })
    ).toBe("run-previous");
  });

  it("falls back to the started run when there is no previous log to preserve", () => {
    expect(
      resolveRunSelectionAfterStart({
        selectedRunId: null,
        previousLastRunId: undefined,
        startedRunId: "run-current"
      })
    ).toBe("run-current");
  });

  it("resolves the viewed run from explicit selection before newer active runs", () => {
    const runs = [
      makeRun({
        id: "run-current",
        status: "running",
        startedAt: "2026-04-01T02:00:00.000Z"
      }),
      makeRun({
        id: "run-previous",
        startedAt: "2026-04-01T01:00:00.000Z"
      })
    ];

    expect(
      resolveViewedRunId({
        runs,
        selectedRunId: "run-previous",
        lastRunId: "run-current"
      })
    ).toBe("run-previous");
  });
});
