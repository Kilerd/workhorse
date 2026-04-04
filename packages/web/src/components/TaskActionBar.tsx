import type { DisplayTask, DisplayTaskColumn } from "@/lib/task-view";
import { getTaskActions } from "@/lib/task-view";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  column: DisplayTaskColumn;
  task?: DisplayTask;
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
  task,
  compact = false,
  onPlan,
  onStart,
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
          ? "inline-flex min-h-[20px] items-center rounded-none border border-border bg-background px-2 text-[0.62rem] uppercase tracking-[0.08em] text-foreground transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-[var(--border-strong)]"
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
