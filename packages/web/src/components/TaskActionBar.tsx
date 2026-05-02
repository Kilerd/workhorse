import type { DisplayTask, DisplayTaskColumn } from "@/lib/task-view";
import { getTaskActions } from "@/lib/task-view";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  column: DisplayTaskColumn;
  task?: DisplayTask;
  compact?: boolean;
  onStop(): void;
  onMoveToTodo(): void;
  onMarkDone(): void;
  onArchive(): void;
}

export function TaskActionBar({
  column,
  task,
  compact = false,
  onStop,
  onMoveToTodo,
  onMarkDone,
  onArchive
}: Props) {
  const actions = getTaskActions(column, task);

  if (actions.length === 0) {
    return null;
  }

  return (
    <span className={cn("flex flex-wrap gap-1.5", compact && "justify-end gap-1")}>
      {actions.map((action) => {
        const className = compact
          ? "inline-flex min-h-7 items-center rounded-full border border-border bg-[var(--panel)] px-2.5 text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-foreground transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
          : buttonVariants({
              variant:
                action.kind === "danger"
                  ? "destructive"
                  : action.kind === "secondary"
                    ? "secondary"
                    : "default"
            });

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
