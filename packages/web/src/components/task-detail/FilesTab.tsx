import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { DisplayTask } from "@/lib/task-view";

import { DiffViewer } from "../DiffViewer";

interface Props {
  task: DisplayTask;
}

export function FilesTab({ task }: Props) {
  const worktreeReady = Boolean(task.worktree?.path && task.worktree.status !== "removed");
  const diffQuery = useQuery({
    queryKey: ["task-diff", task.id],
    queryFn: async () => api.getTaskDiff(task.id),
    enabled: worktreeReady
  });

  if (!worktreeReady) {
    return (
      <div className="grid place-items-center px-6 py-10">
        <div className="surface-card-faint max-w-[34rem] gap-2 px-6 py-8 text-center">
          <p className="m-0 text-[0.92rem] text-[var(--muted-strong)]">
            Worktree is not available for this task.
          </p>
          <p className="m-0 mt-1 text-[0.78rem] text-[var(--muted)]">
            Diff will appear once a worktree is created (typically on first run).
          </p>
        </div>
      </div>
    );
  }

  return (
    <DiffViewer
      files={diffQuery.data?.files ?? []}
      baseRef={diffQuery.data?.baseRef ?? ""}
      headRef={diffQuery.data?.headRef ?? ""}
      isLoading={diffQuery.isLoading}
      error={
        diffQuery.error
          ? diffQuery.error instanceof Error
            ? diffQuery.error.message
            : "Failed to load diff"
          : null
      }
    />
  );
}
