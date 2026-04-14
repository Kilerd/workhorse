import type { ReactNode } from "react";
import type {
  HealthCodexQuotaData,
  HealthCodexQuotaWindowData,
  WorkspaceGitStatusData
} from "@workhorse/contracts";

import { formatCount, formatRelativeTime } from "@/lib/format";
import type { ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./ThemeToggle";

interface SchedulerStatus {
  running: number;
  queued: number;
  blocked: number;
}

interface Props {
  selectedWorkspaceName: string;
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
  schedulerStatus?: SchedulerStatus | null;
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

function quotaToneClass(window: HealthCodexQuotaWindowData): string {
  if (window.remainingPercent <= 15) {
    return "border-[rgba(181,74,74,0.28)] bg-[rgba(181,74,74,0.08)] text-[var(--danger)]";
  }

  if (window.remainingPercent <= 35) {
    return "border-[rgba(166,109,26,0.28)] bg-[rgba(166,109,26,0.08)] text-[var(--warning)]";
  }

  return "border-[rgba(255,79,0,0.22)] bg-[rgba(255,79,0,0.08)] text-[var(--accent-strong)]";
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

function runtimeDotClass(runtimeStatus: string) {
  if (runtimeStatus === "ok") {
    return "bg-[var(--success)]";
  }

  if (runtimeStatus === "connecting") {
    return "bg-[var(--warning)]";
  }

  return "bg-[var(--danger)]";
}

function MetaPill({
  children,
  tone = "default",
  title
}: {
  children: ReactNode;
  tone?: "default" | "accent" | "success" | "warning" | "danger";
  title?: string;
}) {
  const toneClass =
    tone === "accent"
      ? "border-[rgba(255,79,0,0.22)] bg-[rgba(255,79,0,0.08)] text-[var(--accent-strong)]"
      : tone === "success"
        ? "border-[rgba(47,117,88,0.24)] bg-[rgba(47,117,88,0.08)] text-[var(--success)]"
        : tone === "warning"
          ? "border-[rgba(166,109,26,0.24)] bg-[rgba(166,109,26,0.08)] text-[var(--warning)]"
          : tone === "danger"
            ? "border-[rgba(181,74,74,0.24)] bg-[rgba(181,74,74,0.08)] text-[var(--danger)]"
            : "border-border bg-[var(--panel)] text-[var(--muted)]";

  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 text-[0.72rem] font-medium",
        toneClass
      )}
      title={title}
    >
      {children}
    </span>
  );
}

export function TopBar({
  selectedWorkspaceName,
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
  isPulling,
  schedulerStatus
}: Props) {
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

  const hasSchedulerActivity =
    schedulerStatus &&
    (schedulerStatus.running > 0 || schedulerStatus.queued > 0 || schedulerStatus.blocked > 0);

  return (
    <header className="border-b border-border bg-background">
      <div className="grid gap-2 px-3 py-2 sm:px-4 lg:px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="m-0 text-[1.35rem] leading-[1] sm:text-[1.5rem]">
            {selectedWorkspaceName}
          </h1>

          <div className="flex flex-wrap items-center gap-1.5">
            <MetaPill tone={runtimeStatus === "ok" ? "success" : runtimeStatus === "connecting" ? "warning" : "danger"}>
              <span
                aria-hidden="true"
                className={cn("size-2 rounded-full", runtimeDotClass(runtimeStatus))}
              />
              <span>{formatRuntimeStatus(runtimeStatus)}</span>
            </MetaPill>
            <MetaPill>{formatCount(boardCount, "task")}</MetaPill>
            {hasSchedulerActivity ? (
              <MetaPill>
                {schedulerStatus.running} running / {schedulerStatus.queued} queued / {schedulerStatus.blocked} blocked
              </MetaPill>
            ) : null}
            <MetaPill>Updated {formatRelativeTime(lastSyncedAt)}</MetaPill>
            {quotaWindows.map(({ key, window }) => (
              <MetaPill
                key={key}
                tone={window.remainingPercent <= 15 ? "danger" : window.remainingPercent <= 35 ? "warning" : "accent"}
                title={buildQuotaTitle(window, codexQuota)}
              >
                Codex {formatQuotaWindowLabel(window.windowDurationMins)} {window.remainingPercent}%
              </MetaPill>
            ))}
            {codexQuota === null ? <MetaPill>Codex unavailable</MetaPill> : null}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onRefresh}>
              Refresh
            </Button>
            {gitStatus ? (
              <Button type="button" variant="secondary" size="sm" onClick={onPull} disabled={isPulling}>
                {isPulling ? "Pulling…" : "Pull"}
              </Button>
            ) : null}
            <Button type="button" size="sm" className="px-3" onClick={onCreateTask}>
              New task
            </Button>
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          </div>
        </div>
      </div>
    </header>
  );
}
