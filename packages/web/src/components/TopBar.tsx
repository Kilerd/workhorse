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
    return "tone-danger";
  }

  if (window.remainingPercent <= 35) {
    return "tone-warning";
  }

  return "tone-accent";
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
      ? "tone-accent"
      : tone === "success"
        ? "tone-success"
        : tone === "warning"
          ? "tone-warning"
          : tone === "danger"
            ? "tone-danger"
            : "tone-muted";

  return (
    <span
      className={cn("status-pill text-[0.68rem]", toneClass)}
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
    <header className="border-b border-border bg-background backdrop-blur-xl">
      <div className="grid gap-3 px-3.5 py-3 sm:px-4 sm:py-3.5 lg:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="section-kicker">{selectedWorkspaceName}</span>
          <div className="flex items-center gap-1.5 self-start xl:self-center">
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

        <div className="flex flex-wrap items-center gap-1.5">
          <MetaPill
            tone={
              runtimeStatus === "ok"
                ? "success"
                : runtimeStatus === "connecting"
                  ? "warning"
                  : "danger"
            }
          >
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
              tone={
                window.remainingPercent <= 15
                  ? "danger"
                  : window.remainingPercent <= 35
                    ? "warning"
                    : "accent"
              }
              title={buildQuotaTitle(window, codexQuota)}
            >
              Codex {formatQuotaWindowLabel(window.windowDurationMins)} {window.remainingPercent}%
            </MetaPill>
          ))}
          {codexQuota === null ? <MetaPill>Codex unavailable</MetaPill> : null}
        </div>
      </div>
    </header>
  );
}
