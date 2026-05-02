import { useMemo } from "react";
import type { Run, Thread } from "@workhorse/contracts";

import type { DisplayTask } from "@/lib/task-view";
import { buildPhaseFilter } from "@/lib/run-phase";

import { ThreadView } from "../ThreadView";

interface Props {
  task: DisplayTask;
  thread: Thread | null;
  runs: Run[];
}

function placeholderForColumn(column: DisplayTask["column"]): string {
  switch (column) {
    case "backlog":
    case "todo":
      return "Refine scope or @coordinator start when ready…";
    case "running":
      return "Direct @worker or coordinate via @coordinator…";
    case "blocked":
      return "@coordinator why is this still blocked?";
    case "review":
      return "Add a follow-up note for the coding side…";
    default:
      return "Add a follow-up note (read-only after archive)…";
  }
}

export function CodingTab({ task, thread, runs }: Props) {
  const filter = useMemo(() => buildPhaseFilter(runs, "coding"), [runs]);

  if (!thread) {
    return (
      <div className="grid place-items-center px-6 py-10">
        <div className="surface-card-faint max-w-[34rem] gap-2 px-6 py-8 text-center">
          <p className="m-0 text-[0.92rem] text-[var(--muted-strong)]">
            No task thread yet.
          </p>
          <p className="m-0 mt-1 text-[0.78rem] text-[var(--muted)]">
            A coordinator agent must be mounted in this workspace to start a coding conversation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ThreadView
      threadId={thread.id}
      thread={thread}
      messageFilter={filter}
      composerPlaceholder={placeholderForColumn(task.column)}
      emptyState={
        <div className="grid gap-1">
          <p className="m-0 text-[var(--muted-strong)]">No coding run yet.</p>
          <p className="m-0 text-[0.78rem]">
            Try <code className="font-mono">@coordinator plan this task</code> to begin.
          </p>
        </div>
      }
      className="h-full"
    />
  );
}
