import type { Workspace } from "@workhorse/contracts";

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
  runtimeStatus
}: Props) {
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
