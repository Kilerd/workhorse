import type { DisplayTaskColumn } from "@/lib/task-view";
import { getTaskActions } from "@/lib/task-view";

interface Props {
  column: DisplayTaskColumn;
  compact?: boolean;
  onPlan(): void;
  onStart(): void;
  onStop(): void;
  onMoveToTodo(): void;
  onMarkDone(): void;
  onArchive(): void;
}

export function TaskActionBar({
  column,
  compact = false,
  onPlan,
  onStart,
  onStop,
  onMoveToTodo,
  onMarkDone,
  onArchive
}: Props) {
  const actions = getTaskActions(column);

  if (actions.length === 0) {
    return null;
  }

  return (
    <span className={compact ? "task-card-actions task-card-actions-compact" : "task-card-actions"}>
      {actions.map((action) => {
        const className = compact
          ? "action-chip"
          : action.kind === "primary"
            ? "button"
            : action.kind === "danger"
              ? "button button-danger"
              : "button button-secondary";

        const label = compact ? action.shortLabel ?? action.label : action.label;

        return (
          <button
            type="button"
            key={action.id}
            className={className}
            title={action.label}
            onClick={(event) => {
              event.stopPropagation();
              switch (action.id) {
                case "plan":
                  onPlan();
                  break;
                case "start":
                  onStart();
                  break;
                case "stop":
                  onStop();
                  break;
                case "move-to-todo":
                  onMoveToTodo();
                  break;
                case "mark-done":
                  onMarkDone();
                  break;
                case "archive":
                  onArchive();
                  break;
              }
            }}
          >
            {label}
          </button>
        );
      })}
    </span>
  );
}
