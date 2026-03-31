import type { Workspace } from "@workhorse/contracts";

import { formatRelativeTime } from "@/lib/format";

interface Props {
  workspaces: Workspace[];
  selectedWorkspaceId: string | "all";
  onWorkspaceChange(value: string | "all"): void;
  onCreateWorkspace(): void;
  onCreateTask(): void;
  onRefresh(): void;
  lastSyncedAt?: string;
  boardCount: number;
}

export function TopBar({
  workspaces,
  selectedWorkspaceId,
  onWorkspaceChange,
  onCreateWorkspace,
  onCreateTask,
  onRefresh,
  lastSyncedAt,
  boardCount
}: Props) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Workhorse</p>
        <h1>Local kanban for parallel workspaces</h1>
        <p className="topbar-copy">
          聚合多个工作目录，启动任务，观察运行日志。
        </p>
      </div>
      <div className="topbar-controls">
        <label className="select">
          <span>Workspace</span>
          <select
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
        <div className="meta-chip">
          {boardCount} tasks · {lastSyncedAt ? formatRelativeTime(lastSyncedAt) : "syncing"}
        </div>
      </div>
    </header>
  );
}
