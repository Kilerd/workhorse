import type { Task } from "@workhorse/contracts";

/**
 * Directed Acyclic Graph of task dependencies.
 *
 * An edge A → B means "A depends on B" (B must be done before A can start).
 */
export class DependencyGraph {
  /** taskId → set of dependency taskIds (predecessors) */
  private readonly deps: Map<string, Set<string>>;

  /** taskId → set of dependent taskIds (successors / downstream) */
  private readonly rdeps: Map<string, Set<string>>;

  /** Ordered snapshot of tasks used to build the graph */
  private readonly tasks: Task[];

  private constructor(tasks: Task[]) {
    this.tasks = tasks;
    this.deps = new Map();
    this.rdeps = new Map();

    for (const task of tasks) {
      if (!this.deps.has(task.id)) {
        this.deps.set(task.id, new Set());
      }
      if (!this.rdeps.has(task.id)) {
        this.rdeps.set(task.id, new Set());
      }
      for (const depId of task.dependencies) {
        this.deps.get(task.id)!.add(depId);
        if (!this.rdeps.has(depId)) {
          this.rdeps.set(depId, new Set());
        }
        this.rdeps.get(depId)!.add(task.id);
      }
    }
  }

  static fromTasks(tasks: Task[]): DependencyGraph {
    return new DependencyGraph(tasks);
  }

  /**
   * Detect a cycle in the dependency graph using DFS.
   * Returns the cycle path (as task IDs) if one exists, or null if the graph is a DAG.
   */
  detectCycle(): string[] | null {
    // Colors: 0 = unvisited, 1 = in-stack, 2 = done
    const color = new Map<string, number>();
    const parent = new Map<string, string | null>();

    for (const task of this.tasks) {
      color.set(task.id, 0);
      parent.set(task.id, null);
    }

    const dfs = (id: string): string[] | null => {
      color.set(id, 1); // in-stack

      for (const depId of this.deps.get(id) ?? []) {
        if (!color.has(depId)) {
          // dependency references a task not in the graph — skip
          continue;
        }
        const depColor = color.get(depId)!;
        if (depColor === 1) {
          // found a back-edge — reconstruct the cycle
          const cycle: string[] = [depId, id];
          let cur: string | null = parent.get(id) ?? null;
          while (cur !== null && cur !== depId) {
            cycle.unshift(cur);
            cur = parent.get(cur) ?? null;
          }
          cycle.unshift(depId);
          return cycle;
        }
        if (depColor === 0) {
          parent.set(depId, id);
          const result = dfs(depId);
          if (result !== null) return result;
        }
      }

      color.set(id, 2); // done
      return null;
    };

    for (const task of this.tasks) {
      if (color.get(task.id) === 0) {
        const cycle = dfs(task.id);
        if (cycle !== null) return cycle;
      }
    }

    return null;
  }

  /**
   * Returns tasks whose all dependencies are in the provided done set,
   * i.e., tasks that are ready to start.
   */
  getReady(doneTasks: Set<string>): Task[] {
    return this.tasks.filter((task) => {
      const deps = this.deps.get(task.id);
      if (!deps || deps.size === 0) return true;
      for (const depId of deps) {
        if (!doneTasks.has(depId)) return false;
      }
      return true;
    });
  }

  /**
   * Returns all tasks transitively downstream of (dependent on) the given task.
   * The given task itself is not included.
   */
  getDownstream(taskId: string): Task[] {
    const visited = new Set<string>();
    const queue = [...(this.rdeps.get(taskId) ?? [])];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const downId of this.rdeps.get(id) ?? []) {
        if (!visited.has(downId)) queue.push(downId);
      }
    }

    const taskById = new Map(this.tasks.map((t) => [t.id, t]));
    return [...visited].flatMap((id) => {
      const t = taskById.get(id);
      return t ? [t] : [];
    });
  }

  /**
   * Topological sort of all tasks (Kahn's algorithm).
   * Tasks with no dependencies come first.
   * Throws if a cycle is detected (caller should run detectCycle first).
   */
  topologicalSort(): Task[] {
    const inDegree = new Map<string, number>();
    for (const task of this.tasks) {
      const validDeps = [...(this.deps.get(task.id) ?? [])].filter((d) =>
        this.deps.has(d)
      );
      inDegree.set(task.id, validDeps.length);
    }

    const queue = this.tasks
      .filter((t) => inDegree.get(t.id) === 0)
      .sort((a, b) => a.order - b.order);

    const result: Task[] = [];
    const taskById = new Map(this.tasks.map((t) => [t.id, t]));

    while (queue.length > 0) {
      // Pick the lowest-order task available
      queue.sort((a, b) => a.order - b.order);
      const task = queue.shift()!;
      result.push(task);

      for (const downId of this.rdeps.get(task.id) ?? []) {
        const degree = (inDegree.get(downId) ?? 0) - 1;
        inDegree.set(downId, degree);
        if (degree === 0) {
          const t = taskById.get(downId);
          if (t) queue.push(t);
        }
      }
    }

    if (result.length !== this.tasks.length) {
      throw new Error("Cycle detected during topological sort");
    }

    return result;
  }

  /**
   * Returns true if the given task can start, meaning all its dependencies
   * are present in the provided done set.
   */
  canStart(task: Task, doneTasks: Set<string>): boolean {
    for (const depId of task.dependencies) {
      if (!doneTasks.has(depId)) return false;
    }
    return true;
  }
}
