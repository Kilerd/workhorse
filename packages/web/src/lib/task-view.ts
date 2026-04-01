import type { CreateTaskBody, Task, TaskColumn } from "@workhorse/contracts";

export type DisplayTaskColumn = TaskColumn;

export type DisplayTask = Task;

export type TaskFormValues = CreateTaskBody;

export type TaskActionId =
  | "plan"
  | "start"
  | "stop"
  | "move-to-todo"
  | "mark-done"
  | "archive";

export interface TaskActionDescriptor {
  id: TaskActionId;
  label: string;
  shortLabel?: string;
  kind: "primary" | "secondary" | "danger";
}

export const BOARD_COLUMNS: Array<{
  id: DisplayTaskColumn;
  title: string;
  tone: string;
}> = [
  { id: "backlog", title: "Backlog", tone: "tone-backlog" },
  { id: "todo", title: "Todo", tone: "tone-todo" },
  { id: "running", title: "Running", tone: "tone-running" },
  { id: "review", title: "Review", tone: "tone-review" },
  { id: "done", title: "Done", tone: "tone-done" },
  { id: "archived", title: "Archived", tone: "tone-archived" }
];

export function getTaskActions(column: DisplayTaskColumn): TaskActionDescriptor[] {
  switch (column) {
    case "backlog":
      return [
        { id: "plan", label: "Plan", kind: "secondary" },
        { id: "start", label: "Start", kind: "primary" }
      ];
    case "todo":
      return [{ id: "start", label: "Start", kind: "primary" }];
    case "running":
      return [{ id: "stop", label: "Stop", kind: "secondary" }];
    case "review":
      return [
        { id: "move-to-todo", label: "Move to Todo", shortLabel: "Todo", kind: "secondary" },
        { id: "mark-done", label: "Mark Done", shortLabel: "Done", kind: "primary" }
      ];
    case "done":
      return [{ id: "archive", label: "Archive", kind: "secondary" }];
    case "archived":
      return [];
  }
}
