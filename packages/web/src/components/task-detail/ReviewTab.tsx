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
    case "review":
      return "Reply to reviewer or @coordinator request another review…";
    case "done":
    case "archived":
      return "Add a closing note (read-only after archive)…";
    default:
      return "Ask @coordinator to start a review when coding is done…";
  }
}

export function ReviewTab({ task, thread, runs }: Props) {
  const filter = useMemo(() => buildPhaseFilter(runs, "review"), [runs]);

  if (!thread) {
    return (
      <div className="grid place-items-center px-6 py-10">
        <div className="surface-card-faint max-w-[34rem] gap-2 px-6 py-8 text-center">
          <p className="m-0 text-[0.92rem] text-[var(--muted-strong)]">No task thread yet.</p>
          <p className="m-0 mt-1 text-[0.78rem] text-[var(--muted)]">
            A coordinator agent must be mounted to start a review.
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
          <p className="m-0 text-[var(--muted-strong)]">No review yet.</p>
          <p className="m-0 text-[0.78rem]">
            Once coding is done, try{" "}
            <code className="font-mono">@coordinator request review</code>.
          </p>
        </div>
      }
      className="h-full"
    />
  );
}
