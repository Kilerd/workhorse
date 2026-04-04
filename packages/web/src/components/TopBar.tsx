import type {
  HealthCodexQuotaData,
  HealthCodexQuotaWindowData,
  Workspace,
  WorkspaceGitStatusData
} from "@workhorse/contracts";

import { formatCount, formatRelativeTime } from "@/lib/format";
import type { ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  workspaces: Workspace[];
  selectedWorkspaceId: string | "all";
  selectedWorkspaceName: string;
  searchQuery: string;
  onSearchChange(value: string): void;
  onWorkspaceChange(value: string | "all"): void;
  onCreateWorkspace(): void;
  onOpenWorkspaceSettings(): void;
  onOpenGlobalSettings(): void;
  onCreateTask(): void;
  onRefresh(): void;
  theme: ThemeMode;
  onToggleTheme(): void;
  lastSyncedAt?: string;
  boardCount: number;
  runtimeStatus: string;
  codexQuota?: HealthCodexQuotaData | null;
  gitStatus: WorkspaceGitStatusData | null;
  onPull(): void;
  isPulling: boolean;
}

function formatRuntimeStatus(runtimeStatus: string) {
  if (runtimeStatus === "ok") {
    return "Runtime ready";
  }

  if (runtimeStatus === "connecting") {
    return "Connecting";
  }

  return runtimeStatus;
}

function formatQuotaWindowLabel(windowDurationMins?: number): string {
  if (windowDurationMins === 300) {
    return "5h";
  }

  if (windowDurationMins === 10_080) {
    return "week";
  }

  if (!windowDurationMins) {
    return "quota";
  }

  if (windowDurationMins % (60 * 24) === 0) {
    return `${windowDurationMins / (60 * 24)}d`;
  }

  if (windowDurationMins % 60 === 0) {
    return `${windowDurationMins / 60}h`;
  }

  return `${windowDurationMins}m`;
}

function getQuotaWindowToneClass(window: HealthCodexQuotaWindowData): string {
  if (window.remainingPercent <= 15) {
    return "border-[rgba(231,106,106,0.34)] bg-[rgba(231,106,106,0.12)] text-foreground";
  }

  if (window.remainingPercent <= 35) {
    return "border-[rgba(233,191,96,0.3)] bg-[rgba(233,191,96,0.14)] text-foreground";
  }

  return "border-[rgba(73,214,196,0.26)] bg-[rgba(73,214,196,0.12)] text-foreground";
}

function buildQuotaTitle(
  window: HealthCodexQuotaWindowData,
  codexQuota?: HealthCodexQuotaData | null
): string | undefined {
  const details = [`${window.remainingPercent}% remaining`];

  if (codexQuota?.planType) {
    details.push(`plan ${codexQuota.planType}`);
  }

  if (window.resetsAt) {
    details.push(`resets ${new Date(window.resetsAt).toLocaleString()}`);
  }

  return details.join(" • ");
}

function buildQuotaGroupTitle(
  quotaWindows: Array<{ window: HealthCodexQuotaWindowData }>,
  codexQuota?: HealthCodexQuotaData | null
): string | undefined {
  if (quotaWindows.length === 0) {
    return undefined;
  }

  return quotaWindows
    .map(
      ({ window }) =>
        `${formatQuotaWindowLabel(window.windowDurationMins)}: ${buildQuotaTitle(window, codexQuota)}`
    )
    .join("\n");
}

export function TopBar({
  workspaces,
  selectedWorkspaceId,
  selectedWorkspaceName,
  searchQuery,
  onSearchChange,
  onWorkspaceChange,
  onCreateWorkspace,
  onOpenWorkspaceSettings,
  onOpenGlobalSettings,
  onCreateTask,
  onRefresh,
  theme,
  onToggleTheme,
  lastSyncedAt,
  boardCount,
  runtimeStatus,
  codexQuota,
  gitStatus,
  onPull,
  isPulling
}: Props) {
  const metaChipClass =
    "inline-flex min-h-5 items-center gap-2 whitespace-nowrap rounded-none border border-border bg-[var(--panel)] px-2 text-[0.64rem] uppercase tracking-[0.08em] text-[var(--muted)]";
  const quotaWindowClass =
    "inline-flex min-h-4 items-center gap-1 whitespace-nowrap rounded-none border border-transparent px-1.5";
  const quotaWindows = [
    codexQuota?.primary
      ? {
          key: "primary",
          window: codexQuota.primary
        }
      : null,
    codexQuota?.secondary
      ? {
          key: "secondary",
          window: codexQuota.secondary
        }
      : null
  ].filter(
    (
      entry
    ): entry is {
      key: string;
      window: HealthCodexQuotaWindowData;
    } => entry !== null
  );

  return (
    <header className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 gap-x-4 border-b border-border bg-[var(--panel)] px-4 py-3 max-[1040px]:grid-cols-1">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="inline-flex shrink-0 items-center gap-2.5">
          <span className="font-mono text-[0.72rem] font-bold tracking-[0.2em] text-[var(--accent)]">
            WORKHORSE
          </span>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Board summary">
          <span
            className={cn(metaChipClass, "text-foreground")}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-[0.45rem] rounded-full bg-[var(--warning)]",
                runtimeStatus === "ok" &&
                  "bg-[var(--success)] shadow-[0_0_0_4px_rgba(99,216,158,0.12)]"
              )}
            />
            {formatRuntimeStatus(runtimeStatus)}
          </span>
          {quotaWindows.length > 0 ? (
            <span
              className={cn(metaChipClass, "gap-1.5 pr-1 text-foreground")}
              title={buildQuotaGroupTitle(quotaWindows, codexQuota)}
            >
              <span className="whitespace-nowrap text-foreground">Codex</span>
              <span className="inline-flex items-center gap-1" aria-label="Codex quota windows">
                {quotaWindows.map(({ key, window }) => (
                  <span
                    key={key}
                    className={cn(quotaWindowClass, getQuotaWindowToneClass(window))}
                    title={buildQuotaTitle(window, codexQuota)}
                  >
                    <span className="text-[var(--muted)]">
                      {formatQuotaWindowLabel(window.windowDurationMins)}
                    </span>
                    <span className="text-foreground">
                      {window.remainingPercent}%
                    </span>
                  </span>
                ))}
              </span>
            </span>
          ) : null}
          {codexQuota === null ? (
            <span className={metaChipClass}>Codex quota unavailable</span>
          ) : null}
          <span className={metaChipClass}>{formatCount(boardCount, "task")}</span>
          <span className={metaChipClass}>Updated {formatRelativeTime(lastSyncedAt)}</span>
          <span className={metaChipClass}>Scope {selectedWorkspaceName}</span>
          {gitStatus ? (
            <>
              <span className={cn(metaChipClass, "gap-1.5")}>
                <svg
                  aria-hidden="true"
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="shrink-0 opacity-60"
                >
                  <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                </svg>
                {gitStatus.branch}
              </span>
              {gitStatus.changedFiles + gitStatus.addedFiles + gitStatus.deletedFiles > 0 ? (
                <span className={metaChipClass}>
                  {gitStatus.changedFiles + gitStatus.addedFiles + gitStatus.deletedFiles} files
                  {gitStatus.addedFiles > 0 ? (
                    <span className="text-[var(--success)]"> +{gitStatus.addedFiles}</span>
                  ) : null}
                  {gitStatus.deletedFiles > 0 ? (
                    <span className="text-[var(--error)]"> -{gitStatus.deletedFiles}</span>
                  ) : null}
                </span>
              ) : null}
              <span className={metaChipClass}>
                ↓ {gitStatus.behind}
              </span>
              <span className={metaChipClass}>
                ↑ {gitStatus.ahead}
              </span>
              <Button
                type="button"
                variant="secondary"
                onClick={onPull}
                disabled={isPulling}
                className="h-5 min-h-5 px-2 text-[0.64rem]"
                title="Pull latest from origin"
              >
                {isPulling ? "Pulling…" : "↓ Pull"}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-end gap-3 max-[1040px]:justify-start">
        <label className="relative flex items-center max-[1040px]:w-full">
          <span className="sr-only">Search tasks</span>
          <Input
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search..."
            className="h-7 min-h-7 w-40 min-w-40 py-0 pr-14 text-[0.75rem] max-[1040px]:w-full max-[1040px]:min-w-0"
          />
          {searchQuery ? (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 border border-transparent bg-transparent text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]"
              onClick={() => onSearchChange("")}
            >
              Clear
            </button>
          ) : null}
        </label>

        <label className="flex items-center max-[1040px]:w-full">
          <span className="sr-only">Workspace</span>
          <NativeSelect
            aria-label="Workspace"
            value={selectedWorkspaceId}
            onChange={(event) => onWorkspaceChange(event.target.value || "all")}
            className="h-7 min-h-7 min-w-40 py-0 pr-7 text-[0.75rem] max-[1040px]:w-full max-[1040px]:min-w-0"
          >
            <option value="all">All workspaces</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </NativeSelect>
        </label>

        <Button type="button" variant="secondary" onClick={onRefresh}>
          Refresh
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onOpenWorkspaceSettings}
          disabled={selectedWorkspaceId === "all"}
        >
          Workspace settings
        </Button>
        <Button type="button" variant="secondary" onClick={onCreateWorkspace}>
          Add workspace
        </Button>
        <Button type="button" onClick={onCreateTask}>
          New
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onOpenGlobalSettings}
        >
          Settings
        </Button>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </header>
  );
}
