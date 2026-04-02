import type { StartTaskBody, Task } from "@workhorse/contracts";

function resolveRunningStartOrder(
  tasks: Task[],
  taskId: string,
  requestedOrder?: number
): number {
  if (typeof requestedOrder === "number") {
    return requestedOrder;
  }

  const firstRunningTask = tasks
    .filter((task) => task.column === "running" && task.id !== taskId)
    .sort((left, right) => left.order - right.order)[0];

  return firstRunningTask ? firstRunningTask.order - 1_024 : 1_024;
}

export function applyOptimisticStartTask(
  tasks: Task[],
  taskId: string,
  body: StartTaskBody = {}
): Task[] {
  const order = resolveRunningStartOrder(tasks, taskId, body.order);

  return tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          column: "running",
          order
        }
      : task
  );
}
