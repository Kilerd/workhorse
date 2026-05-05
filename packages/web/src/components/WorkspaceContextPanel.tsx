import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Workspace, WorkspaceHarnessFile } from "@workhorse/contracts";

import { useWorkspaceHarness } from "@/hooks/useWorkspaceHarness";
import { readErrorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface Props {
  workspace: Workspace;
  active: boolean;
}

export function WorkspaceContextPanel({ workspace, active }: Props) {
  const harness = useWorkspaceHarness(workspace.id, { enabled: active });

  const errorMessage = useMemo(
    () => readErrorMessage(harness.error, "Failed to read harness files."),
    [harness.error]
  );

  return (
    <section className="grid gap-3">
      <header className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <p className="text-[0.82rem] text-[var(--muted)]">
            Files Workhorse agents will read from this workspace's root.
          </p>
          <p className="font-mono text-[0.72rem] text-[var(--muted)]">
            {workspace.rootPath}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={harness.isFetching}
          onClick={() => {
            void harness.refetch();
          }}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", harness.isFetching && "animate-spin")}
          />
          <span className="ml-1.5">Refresh</span>
        </Button>
      </header>

      {harness.isError ? (
        <div className="rounded border border-[var(--accent-strong)]/40 bg-[var(--accent-strong)]/5 px-3 py-2 text-[0.82rem]">
          {errorMessage}
        </div>
      ) : null}

      {harness.isLoading ? (
        <div className="text-[0.82rem] text-[var(--muted)]">Loading…</div>
      ) : null}

      {harness.data?.files.map((file) => (
        <HarnessFileCard key={file.id} file={file} />
      ))}
    </section>
  );
}

function HarnessFileCard({ file }: { file: WorkspaceHarnessFile }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="rounded border border-border">
      <header className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[0.85rem] font-medium">
            {file.relativePath}
          </span>
          <StatusBadge exists={file.exists} />
        </div>
        {file.exists ? (
          <div className="flex items-center gap-3 text-[0.72rem] text-[var(--muted)]">
            <span>{formatBytes(file.sizeBytes ?? 0)}</span>
            <span>{formatModified(file.modifiedAt)}</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide" : "Show"}
            </Button>
          </div>
        ) : null}
      </header>

      {file.exists && expanded ? (
        <div className="border-t border-border">
          {file.truncated ? (
            <div className="border-b border-border bg-[var(--accent-strong)]/5 px-3 py-1.5 text-[0.72rem] text-[var(--accent-strong)]">
              File exceeds 256 KB — showing the first 256 KB.
            </div>
          ) : null}
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[0.78rem] leading-relaxed">
            {file.content ?? ""}
          </pre>
        </div>
      ) : null}
    </article>
  );
}

function StatusBadge({ exists }: { exists: boolean }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[0.68rem] font-medium uppercase tracking-wide",
        exists
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : "bg-[var(--muted)]/15 text-[var(--muted)]"
      )}
    >
      {exists ? "Present" : "Missing"}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatModified(modifiedAt?: string): string {
  if (!modifiedAt) {
    return "";
  }
  try {
    const date = new Date(modifiedAt);
    return `modified ${date.toLocaleString()}`;
  } catch {
    return "";
  }
}
