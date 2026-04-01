import type {
  HealthCodexQuotaData,
  HealthCodexQuotaWindowData,
  Workspace
} from "@workhorse/contracts";

import { formatCount, formatRelativeTime } from "@/lib/format";
import type { ThemeMode } from "@/lib/theme";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  workspaces: Workspace[];
  selectedWorkspaceId: string | "all";
  selectedWorkspaceName: string;
  searchQuery: string;
  onSearchChange(value: string): void;
  onWorkspaceChange(value: string | "all"): void;
  onCreateWorkspace(): void;
  onCreateTask(): void;
  onRefresh(): void;
  theme: ThemeMode;
  onToggleTheme(): void;
  lastSyncedAt?: string;
  boardCount: number;
  runtimeStatus: string;
  codexQuota?: HealthCodexQuotaData | null;
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

function getQuotaWindowTone(window: HealthCodexQuotaWindowData): string {
  if (window.remainingPercent <= 15) {
    return "meta-chip-quota-critical";
  }

  if (window.remainingPercent <= 35) {
    return "meta-chip-quota-low";
  }

  return "meta-chip-quota";
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

export function TopBar({
  workspaces,
  selectedWorkspaceId,
  selectedWorkspaceName,
  searchQuery,
  onSearchChange,
  onWorkspaceChange,
  onCreateWorkspace,
  onCreateTask,
  onRefresh,
  theme,
  onToggleTheme,
  lastSyncedAt,
  boardCount,
  runtimeStatus,
  codexQuota
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

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="topbar-wordmark">
          <span className="wordmark">WORKHORSE</span>
          <span className="topbar-divider" aria-hidden="true" />
          <span className="topbar-product">Local Kanban</span>
        </div>
        <div className="topbar-meta" aria-label="Board summary">
          <span
            className={`meta-chip meta-chip-status ${
              runtimeStatus === "ok" ? "meta-chip-status-ok" : ""
            }`}
          >
            <span className="status-dot" aria-hidden="true" />
            {formatRuntimeStatus(runtimeStatus)}
          </span>
          {quotaWindows.map(({ key, window }) => (
            <span
              key={key}
              className={`meta-chip ${getQuotaWindowTone(window)}`}
              title={buildQuotaTitle(window, codexQuota)}
            >
              Codex {formatQuotaWindowLabel(window.windowDurationMins)}{" "}
              {window.remainingPercent}% left
            </span>
          ))}
          {codexQuota === null ? (
            <span className="meta-chip">Codex quota unavailable</span>
          ) : null}
          <span className="meta-chip">{formatCount(boardCount, "task")}</span>
          <span className="meta-chip">Updated {formatRelativeTime(lastSyncedAt)}</span>
          <span className="meta-chip">Scope {selectedWorkspaceName}</span>
        </div>
      </div>

      <div className="topbar-controls">
        <label className="search-field">
          <span className="sr-only">Search tasks</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search..."
          />
          {searchQuery ? (
            <button
              type="button"
              className="search-clear"
              onClick={() => onSearchChange("")}
            >
              Clear
            </button>
          ) : null}
        </label>

        <label className="select toolbar-select">
          <span className="sr-only">Workspace</span>
          <select
            aria-label="Workspace"
            value={selectedWorkspaceId}
            onChange={(event) => onWorkspaceChange(event.target.value || "all")}
          >
            <option value="all">All workspaces</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="button button-secondary" onClick={onRefresh}>
          Refresh
        </button>
        <button type="button" className="button button-secondary" onClick={onCreateWorkspace}>
          Add workspace
        </button>
        <button type="button" className="button" onClick={onCreateTask}>
          New
        </button>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </header>
  );
}
