import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileDiff } from "lucide-react";

import { api } from "@/lib/api";

import { DiffViewer } from "./DiffViewer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "./ui/sheet";

interface Props {
  scope:
    | { kind: "task"; taskId: string }
    | { kind: "workspace"; workspaceId: string };
}

export function WorktreeDiffSummary({ scope }: Props) {
  const [open, setOpen] = useState(false);
  const queryKey =
    scope.kind === "task"
      ? ["task-diff", scope.taskId]
      : ["workspace-diff", scope.workspaceId];

  const diffQuery = useQuery({
    queryKey,
    queryFn: async () =>
      scope.kind === "task"
        ? api.getTaskDiff(scope.taskId)
        : api.getWorkspaceDiff(scope.workspaceId),
    refetchInterval: open ? 5_000 : 30_000
  });

  if (diffQuery.isError) {
    return null;
  }

  const files = diffQuery.data?.files ?? [];
  const fileCount = files.length;
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const baseRef = diffQuery.data?.baseRef ?? "";
  const headRef = diffQuery.data?.headRef ?? "";

  if (!diffQuery.isLoading && fileCount === 0) {
    return null;
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-[var(--panel)] px-2 py-1.5 text-xs transition-colors hover:bg-[var(--surface-hover)]"
          title={`${fileCount} file${fileCount === 1 ? "" : "s"} changed`}
        >
          <FileDiff
            className="size-3.5 shrink-0 text-[var(--muted)]"
            aria-hidden="true"
          />
          {diffQuery.isLoading && fileCount === 0 ? (
            <span className="font-mono text-[0.7rem] text-[var(--muted)]">…</span>
          ) : (
            <>
              <span className="font-mono text-[0.7rem] text-[var(--success)]">
                +{additions}
              </span>
              <span className="font-mono text-[0.7rem] text-[var(--danger)]">
                −{deletions}
              </span>
              <span className="font-mono text-[0.66rem] text-[var(--muted)]">
                {fileCount} file{fileCount === 1 ? "" : "s"}
              </span>
            </>
          )}
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-[44rem]">
        <SheetHeader>
          <div className="grid min-w-0 gap-0.5">
            <SheetTitle>Worktree changes</SheetTitle>
            <SheetDescription>
              {baseRef && headRef ? `${baseRef} → ${headRef}` : "Uncommitted changes"}
            </SheetDescription>
          </div>
          <span className="shrink-0 font-mono text-[0.7rem] text-[var(--muted)]">
            <span className="text-[var(--success)]">+{additions}</span>{" "}
            <span className="text-[var(--danger)]">−{deletions}</span> · {fileCount}{" "}
            file{fileCount === 1 ? "" : "s"}
          </span>
        </SheetHeader>
        <DiffViewer
          files={files}
          baseRef={baseRef}
          headRef={headRef}
          isLoading={diffQuery.isLoading}
          error={null}
        />
      </SheetContent>
    </Sheet>
  );
}
