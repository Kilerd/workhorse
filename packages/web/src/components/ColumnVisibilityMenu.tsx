import { useEffect, useRef } from "react";

import { BOARD_COLUMNS, type DisplayTaskColumn } from "@/lib/task-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  visibleColumnIds: DisplayTaskColumn[];
  onToggle(id: DisplayTaskColumn): void;
  onReset(): void;
}

export function ColumnVisibilityMenu({ visibleColumnIds, onToggle, onReset }: Props) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const visible = new Set(visibleColumnIds);
  const allVisible = visibleColumnIds.length === BOARD_COLUMNS.length;

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const node = detailsRef.current;
      if (!node || !node.open) {
        return;
      }
      if (event.target instanceof Node && !node.contains(event.target)) {
        node.open = false;
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <details ref={detailsRef} className="relative">
      <summary
        className="list-none [&::-webkit-details-marker]:hidden"
        aria-label="Toggle column visibility menu"
      >
        <Button asChild type="button" variant="secondary" size="sm">
          <span className="cursor-pointer select-none">
            Columns {visibleColumnIds.length}/{BOARD_COLUMNS.length}
          </span>
        </Button>
      </summary>
      <div
        className="absolute right-0 top-full z-30 mt-1.5 w-52 rounded-[10px] border border-border bg-background p-1 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.35)]"
        role="menu"
      >
        <ul className="grid gap-0.5">
          {BOARD_COLUMNS.map((column) => {
            const checked = visible.has(column.id);
            const onlyVisible = checked && visibleColumnIds.length === 1;
            return (
              <li key={column.id}>
                <label
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-[8px] px-2 py-1.5 text-[0.8rem] text-foreground transition-colors",
                    onlyVisible
                      ? "cursor-not-allowed opacity-60"
                      : "cursor-pointer hover:bg-[var(--surface-hover)]"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid size-4 place-items-center rounded-[4px] border transition-colors",
                        checked
                          ? "border-[var(--accent)] bg-[var(--accent)]"
                          : "border-border bg-transparent"
                      )}
                    >
                      {checked ? (
                        <svg
                          viewBox="0 0 12 12"
                          className="size-3 text-[var(--accent-foreground)]"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M2.5 6.5 5 9l4.5-5.5" />
                        </svg>
                      ) : null}
                    </span>
                    <span>{column.title}</span>
                  </span>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    disabled={onlyVisible}
                    onChange={() => onToggle(column.id)}
                  />
                </label>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            className={cn(
              "w-full rounded-[8px] px-2 py-1.5 text-left text-[0.78rem] transition-colors",
              allVisible
                ? "cursor-not-allowed text-[var(--muted)] opacity-60"
                : "text-[var(--muted-strong)] hover:bg-[var(--surface-hover)] hover:text-foreground"
            )}
            disabled={allVisible}
            onClick={onReset}
          >
            Show all columns
          </button>
        </div>
      </div>
    </details>
  );
}
