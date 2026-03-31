import type { Workspace } from "@workhorse/contracts";

import { formatRelativeTime } from "@/lib/format";

interface Props {
  workspaces: Workspace[];
  selectedWorkspaceId: string | "all";
  selectedWorkspaceName: string;
  onWorkspaceChange(value: string | "all"): void;
  onCreateWorkspace(): void;
  onCreateTask(): void;
  onRefresh(): void;
  lastSyncedAt?: string;
  boardCount: number;
  runtimeStatus: string;
}

function formatTaskSummary(boardCount: number, lastSyncedAt?: string) {
  const taskLabel = `${boardCount} ${boardCount === 1 ? "task" : "tasks"}`;
  return `${taskLabel} \u00b7 ${lastSyncedAt ? `Updated ${formatRelativeTime(lastSyncedAt)}` : "Syncing"}`;
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
  onWorkspaceChange,
  onCreateWorkspace,
  onCreateTask,
  onRefresh,
  lastSyncedAt,
  boardCount,
  runtimeStatus
}: Props) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="topbar-heading">
          <p className="eyebrow">Workhorse</p>
          <h1>Local kanban for parallel workspaces</h1>
        </div>
        <p className="topbar-copy">
          聚合多个工作目录，启动任务，观察运行日志。
        </p>
        <div className="topbar-meta" aria-label="Board summary">
          <span className="meta-chip">Showing {selectedWorkspaceName}</span>
          <span
            className={`meta-chip meta-chip-status ${
              runtimeStatus === "ok" ? "meta-chip-status-ok" : "meta-chip-status-pending"
            }`}
          >
            <span className="status-dot" aria-hidden="true" />
            {formatRuntimeStatus(runtimeStatus)}
          </span>
          <span className="meta-chip">
            {formatTaskSummary(boardCount, lastSyncedAt)}
          </span>
        </div>
      </div>
      <div className="topbar-controls">
        <label className="select select-inline">
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
        <div className="topbar-actions">
          <button type="button" className="button button-secondary" onClick={onRefresh}>
            Refresh
          </button>
          <button type="button" className="button button-secondary" onClick={onCreateWorkspace}>
            Add workspace
          </button>
          <button type="button" className="button" onClick={onCreateTask}>
            New task
          </button>
        </div>
      </div>
    </header>
  );
}
