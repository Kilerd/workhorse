import type { RunnerType, Task } from "@workhorse/contracts";

import type { StateStore } from "../persistence/state-store.js";
import type { EventBus } from "../ws/event-bus.js";
import type { StartTaskOptions } from "./run-lifecycle-service.js";
import { DependencyGraph } from "./dependency-graph.js";

export interface SchedulerConfig {
  maxConcurrent: number;
  maxPerRunner?: Partial<Record<RunnerType, number>>;
}

interface TaskSchedulerDependencies {
  store: StateStore;
  events: EventBus;
  lifecycle: {
    startTask(taskId: string, options?: StartTaskOptions): Promise<unknown>;
    isActive(taskId: string): boolean;
    activeCount(): number;
    activeCountByRunner(type: RunnerType): number;
  };
}

export class TaskScheduler {
  private evaluationChain = Promise.resolve();

  constructor(
    private readonly config: SchedulerConfig,
    private readonly deps: TaskSchedulerDependencies
  ) {}

  public evaluate(): Promise<void> {
    const next = this.evaluationChain.then(() => this.evaluateUnsafe());
    this.evaluationChain = next.catch(() => {});
    return next;
  }

  public canStart(task: Task, source = this.deps.store.listTasks()): boolean {
    const doneTasks = new Set(
      source.filter((entry) => entry.column === "done").map((entry) => entry.id)
    );
    return DependencyGraph.fromTasks(source).canStart(task, doneTasks);
  }

  public activeCount(): number {
    return this.deps.lifecycle.activeCount();
  }

  public activeCountByRunner(type: RunnerType): number {
    return this.deps.lifecycle.activeCountByRunner(type);
  }

  private async evaluateUnsafe(): Promise<void> {
    const changedTaskIds = await this.syncBlockedColumns();
    if (changedTaskIds.length > 0) {
      const latestTasks = this.deps.store.listTasks();
      const changedTasks = latestTasks.filter((task) => changedTaskIds.includes(task.id));
      for (const task of changedTasks) {
        this.deps.events.publish({
          type: "task.updated",
          action: "updated",
          taskId: task.id,
          task
        });
      }
    }

    const tasks = this.deps.store.listTasks();
    const readyTasks = tasks
      .filter(
        (task) =>
          task.column === "todo" &&
          !this.deps.lifecycle.isActive(task.id) &&
          this.canStart(task, tasks)
      )
      .sort((left, right) => left.order - right.order);

    if (readyTasks.length === 0) {
      return;
    }

    let remainingCapacity = this.config.maxConcurrent - this.activeCount();
    if (remainingCapacity <= 0) {
      return;
    }

    const activeByRunner = new Map<RunnerType, number>();
    for (const runnerType of ["claude", "codex", "shell"] as const) {
      activeByRunner.set(runnerType, this.activeCountByRunner(runnerType));
    }

    const startQueue: Task[] = [];
    for (const task of readyTasks) {
      if (remainingCapacity <= 0) {
        break;
      }

      const runnerLimit = this.config.maxPerRunner?.[task.runnerType];
      const runnerActive = activeByRunner.get(task.runnerType) ?? 0;
      if (runnerLimit !== undefined && runnerActive >= runnerLimit) {
        continue;
      }

      startQueue.push(task);
      remainingCapacity -= 1;
      activeByRunner.set(task.runnerType, runnerActive + 1);
    }

    for (const task of startQueue.reverse()) {
      try {
        await this.deps.lifecycle.startTask(task.id, {
          allowedColumns: ["todo"]
        });
      } catch {
        // A failed task launch should not block other ready tasks in the queue.
      }
    }
  }

  private async syncBlockedColumns(): Promise<string[]> {
    return this.deps.store.updateState((state) => {
      const doneTasks = new Set(
        state.tasks
          .filter((task) => task.column === "done")
          .map((task) => task.id)
      );
      const graph = DependencyGraph.fromTasks(state.tasks);
      const changedTaskIds: string[] = [];
      for (const task of state.tasks) {
        const ready = graph.canStart(task, doneTasks);
        if (task.column === "todo" && !ready) {
          task.column = "blocked";
          task.updatedAt = new Date().toISOString();
          changedTaskIds.push(task.id);
          continue;
        }

        if (task.column === "blocked" && ready) {
          task.column = "todo";
          task.updatedAt = new Date().toISOString();
          changedTaskIds.push(task.id);
        }
      }

      return changedTaskIds;
    });
  }
}
