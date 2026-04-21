import { describe, expect, it } from "vitest";

import type { Task } from "@workhorse/contracts";

import { DependencyGraph } from "./dependency-graph.js";

function makeTask(id: string, dependencies: string[] = [], order = 0): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    workspaceId: "ws-1",
    column: "todo",
    order,
    runnerType: "shell",
    runnerConfig: { type: "shell", command: "echo done" },
    dependencies,
    taskKind: "user",
    worktree: {
      baseRef: "origin/main",
      branchName: `task/${id}`,
      status: "not_created"
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("DependencyGraph.detectCycle", () => {
  it("returns null for a graph with no dependencies", () => {
    const graph = DependencyGraph.fromTasks([makeTask("a"), makeTask("b"), makeTask("c")]);
    expect(graph.detectCycle()).toBeNull();
  });

  it("returns null for a valid dependency chain (a → b → c)", () => {
    const graph = DependencyGraph.fromTasks([
      makeTask("a", ["b"]),
      makeTask("b", ["c"]),
      makeTask("c")
    ]);
    expect(graph.detectCycle()).toBeNull();
  });

  it("returns null for a diamond dependency (a → b, a → c, b → d, c → d)", () => {
    const graph = DependencyGraph.fromTasks([
      makeTask("a", ["b", "c"]),
      makeTask("b", ["d"]),
      makeTask("c", ["d"]),
      makeTask("d")
    ]);
    expect(graph.detectCycle()).toBeNull();
  });

  it("detects a direct self-loop (a → a)", () => {
    const graph = DependencyGraph.fromTasks([makeTask("a", ["a"])]);
    const cycle = graph.detectCycle();
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("a");
  });

  it("detects a two-node cycle (a → b → a)", () => {
    const graph = DependencyGraph.fromTasks([makeTask("a", ["b"]), makeTask("b", ["a"])]);
    const cycle = graph.detectCycle();
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
    expect(cycle).toContain("a");
    expect(cycle).toContain("b");
  });

  it("detects a three-node cycle (a → b → c → a)", () => {
    const graph = DependencyGraph.fromTasks([
      makeTask("a", ["b"]),
      makeTask("b", ["c"]),
      makeTask("c", ["a"])
    ]);
    const cycle = graph.detectCycle();
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(3);
  });

  it("does not treat a dependency on an unknown task as a cycle", () => {
    const graph = DependencyGraph.fromTasks([makeTask("a", ["nonexistent"])]);
    expect(graph.detectCycle()).toBeNull();
  });
});

describe("DependencyGraph.getReady", () => {
  it("returns all tasks when none have dependencies", () => {
    const tasks = [makeTask("a"), makeTask("b"), makeTask("c")];
    const graph = DependencyGraph.fromTasks(tasks);
    const ready = graph.getReady(new Set());
    expect(ready.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("returns only tasks whose dependencies are done", () => {
    const graph = DependencyGraph.fromTasks([
      makeTask("a", ["b"]),
      makeTask("b", ["c"]),
      makeTask("c")
    ]);

    expect(graph.getReady(new Set()).map((t) => t.id)).toEqual(["c"]);
    expect(graph.getReady(new Set(["c"])).map((t) => t.id).sort()).toEqual(["b", "c"]);
    expect(graph.getReady(new Set(["b", "c"])).map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("requires ALL dependencies to be done", () => {
    const graph = DependencyGraph.fromTasks([makeTask("a", ["b", "c"]), makeTask("b"), makeTask("c")]);
    // only b is done — a is not ready
    expect(graph.getReady(new Set(["b"])).map((t) => t.id).sort()).toEqual(["b", "c"]);
    // both b and c done — a is ready
    expect(graph.getReady(new Set(["b", "c"])).map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("DependencyGraph.getDownstream", () => {
  it("returns an empty array for a task with no dependents", () => {
    const graph = DependencyGraph.fromTasks([makeTask("a", ["b"]), makeTask("b")]);
    expect(graph.getDownstream("a")).toEqual([]);
  });

  it("returns direct dependents", () => {
    const graph = DependencyGraph.fromTasks([
      makeTask("a", ["b"]),
      makeTask("b"),
      makeTask("c", ["b"])
    ]);
    const down = graph.getDownstream("b").map((t) => t.id).sort();
    expect(down).toEqual(["a", "c"]);
  });

  it("returns transitive dependents", () => {
    // a → b → c (b depends on c, a depends on b)
    const graph = DependencyGraph.fromTasks([
      makeTask("a", ["b"]),
      makeTask("b", ["c"]),
      makeTask("c")
    ]);
    const down = graph.getDownstream("c").map((t) => t.id).sort();
    expect(down).toEqual(["a", "b"]);
  });
});

describe("DependencyGraph.topologicalSort", () => {
  it("returns tasks in dependency-first order for a linear chain", () => {
    const graph = DependencyGraph.fromTasks([
      makeTask("a", ["b"], 0),
      makeTask("b", ["c"], 1),
      makeTask("c", [], 2)
    ]);
    const sorted = graph.topologicalSort().map((t) => t.id);
    // c must come before b, b before a
    expect(sorted.indexOf("c")).toBeLessThan(sorted.indexOf("b"));
    expect(sorted.indexOf("b")).toBeLessThan(sorted.indexOf("a"));
  });

  it("handles a graph with no dependencies (returns all tasks)", () => {
    const tasks = [makeTask("a"), makeTask("b"), makeTask("c")];
    const graph = DependencyGraph.fromTasks(tasks);
    expect(graph.topologicalSort()).toHaveLength(3);
  });

  it("handles a diamond graph", () => {
    // a → b → d
    // a → c → d
    const graph = DependencyGraph.fromTasks([
      makeTask("a", ["b", "c"], 0),
      makeTask("b", ["d"], 1),
      makeTask("c", ["d"], 2),
      makeTask("d", [], 3)
    ]);
    const sorted = graph.topologicalSort().map((t) => t.id);
    expect(sorted.indexOf("d")).toBeLessThan(sorted.indexOf("b"));
    expect(sorted.indexOf("d")).toBeLessThan(sorted.indexOf("c"));
    expect(sorted.indexOf("b")).toBeLessThan(sorted.indexOf("a"));
    expect(sorted.indexOf("c")).toBeLessThan(sorted.indexOf("a"));
  });

  it("throws on a cyclic graph", () => {
    const graph = DependencyGraph.fromTasks([makeTask("a", ["b"]), makeTask("b", ["a"])]);
    expect(() => graph.topologicalSort()).toThrow();
  });
});

describe("DependencyGraph.canStart", () => {
  it("returns true for a task with no dependencies", () => {
    const graph = DependencyGraph.fromTasks([makeTask("a")]);
    expect(graph.canStart(makeTask("a"), new Set())).toBe(true);
  });

  it("returns false when a dependency is not done", () => {
    const task = makeTask("a", ["b"]);
    const graph = DependencyGraph.fromTasks([task, makeTask("b")]);
    expect(graph.canStart(task, new Set())).toBe(false);
    expect(graph.canStart(task, new Set(["c"]))).toBe(false);
  });

  it("returns true when all dependencies are done", () => {
    const task = makeTask("a", ["b", "c"]);
    const graph = DependencyGraph.fromTasks([task, makeTask("b"), makeTask("c")]);
    expect(graph.canStart(task, new Set(["b", "c"]))).toBe(true);
  });

  it("returns false when only some dependencies are done", () => {
    const task = makeTask("a", ["b", "c"]);
    const graph = DependencyGraph.fromTasks([task, makeTask("b"), makeTask("c")]);
    expect(graph.canStart(task, new Set(["b"]))).toBe(false);
  });
});
