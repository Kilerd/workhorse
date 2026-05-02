import { useEffect, useRef, useState } from "react";

import type { DisplayTask } from "@/lib/task-view";

interface Props {
  task: DisplayTask;
  allTasks: DisplayTask[];
  onSetDependencies(ids: string[]): void;
}

export function DependencyPicker({ task, allTasks, onSetDependencies }: Props) {
  const [localDeps, setLocalDeps] = useState<string[]>(task.dependencies);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalDeps(task.dependencies);
  }, [task.dependencies]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const candidates = allTasks.filter(
    (t) => t.id !== task.id && t.workspaceId === task.workspaceId && t.column !== "archived"
  );

  if (candidates.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-1">
      {candidates.map((candidate) => {
        const checked = localDeps.includes(candidate.id);
        return (
          <label
            key={candidate.id}
            className="flex cursor-pointer items-start gap-2 rounded-[var(--radius)] px-2 py-2 transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
          >
            <input
              type="checkbox"
              className="mt-[3px] shrink-0 accent-[var(--accent)]"
              checked={checked}
              onChange={() => {
                const next = checked
                  ? localDeps.filter((id) => id !== candidate.id)
                  : [...localDeps, candidate.id];
                setLocalDeps(next);
                if (timerRef.current) clearTimeout(timerRef.current);
                timerRef.current = setTimeout(() => onSetDependencies(next), 300);
              }}
            />
            <span className="min-w-0 break-words text-[0.88rem] leading-[1.5] text-[var(--muted)]">
              {candidate.title}
            </span>
          </label>
        );
      })}
    </div>
  );
}
