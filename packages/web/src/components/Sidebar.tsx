import { useMemo } from "react";
import type { Workspace } from "@workhorse/contracts";

import type { DisplayTask } from "@/lib/task-view";
import { cn } from "@/lib/utils";

interface Props {
  workspaces: Workspace[];
  allTasks: DisplayTask[];
  teamCount: number;
  selectedWorkspaceId: string | "all";
  collapsed: boolean;
  onToggleCollapse(): void;
  onSelectWorkspace(id: string | "all"): void;
  onAddWorkspace(): void;
  onOpenTeams(): void;
  onOpenWorkspaceSettings(): void;
  onOpenGlobalSettings(): void;
}

interface WorkspaceBadge {
  inProgress: number;
  review: number;
}

function computeBadges(
  tasks: DisplayTask[],
  workspaceId: string | null
): WorkspaceBadge {
  const filtered = workspaceId
    ? tasks.filter((t) => t.workspaceId === workspaceId)
    : tasks;

  return {
    inProgress: filtered.filter((t) => t.column === "running").length,
    review: filtered.filter((t) => t.column === "review").length
  };
}

function shortenPath(rootPath: string): string {
  const parts = rootPath.replace(/\/$/, "").split("/");
  if (parts.length <= 2) {
    return rootPath;
  }
  return `~/${parts.slice(-1)[0]}`;
}

export function Sidebar({
  workspaces,
  allTasks,
  teamCount,
  selectedWorkspaceId,
  collapsed,
  onToggleCollapse,
  onSelectWorkspace,
  onAddWorkspace,
  onOpenTeams,
  onOpenWorkspaceSettings,
  onOpenGlobalSettings
}: Props) {
  const badgesByWorkspace = useMemo(() => {
    const map = new Map<string, WorkspaceBadge>();
    for (const ws of workspaces) {
      map.set(ws.id, computeBadges(allTasks, ws.id));
    }
    return map;
  }, [workspaces, allTasks]);

  const allBadge = useMemo(
    () => computeBadges(allTasks, null),
    [allTasks]
  );

  if (collapsed) {
    return (
      <aside className="flex h-full w-10 flex-col items-center border-r border-border bg-[var(--bg)] py-3">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex size-7 items-center justify-center rounded-sm border border-border bg-transparent text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
          title="Expand sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 3l5 5-5 5" />
          </svg>
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-60 flex-col border-r border-border bg-[var(--bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <span className="font-mono text-[0.72rem] font-bold tracking-[0.2em] text-[var(--accent)]">
          WORKHORSE
        </span>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex size-6 items-center justify-center rounded-sm border border-transparent bg-transparent text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
          title="Collapse sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10 3l-5 5 5 5" />
          </svg>
        </button>
      </div>

      {/* Workspace list */}
      <nav className="flex-1 overflow-y-auto overscroll-contain p-2">
        {/* All workspaces */}
        <button
          type="button"
          onClick={() => onSelectWorkspace("all")}
          className={cn(
            "mb-1 flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-[0.78rem] transition-colors",
            selectedWorkspaceId === "all"
              ? "bg-[var(--accent)] text-white"
              : "text-foreground hover:bg-[var(--surface-hover)]"
          )}
        >
          <span className="flex-1 truncate font-medium">All workspaces</span>
          <BadgeGroup badge={allBadge} active={selectedWorkspaceId === "all"} />
        </button>

        {workspaces.map((ws) => {
          const active = selectedWorkspaceId === ws.id;
          const badge = badgesByWorkspace.get(ws.id);

          return (
            <button
              key={ws.id}
              type="button"
              onClick={() => onSelectWorkspace(ws.id)}
              className={cn(
                "mb-0.5 flex w-full flex-col gap-0.5 rounded-sm px-2.5 py-2 text-left transition-colors",
                active
                  ? "bg-[var(--accent)] text-white"
                  : "text-foreground hover:bg-[var(--surface-hover)]"
              )}
            >
              <div className="flex w-full items-center gap-2">
                <span className="flex-1 truncate text-[0.78rem] font-medium">
                  {ws.name}
                </span>
                {badge ? (
                  <BadgeGroup badge={badge} active={active} />
                ) : null}
              </div>
              <span
                className={cn(
                  "truncate text-[0.64rem]",
                  active ? "text-white/70" : "text-[var(--muted)]"
                )}
              >
                {shortenPath(ws.rootPath)}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Bottom actions */}
      <div className="flex flex-col gap-1 border-t border-border p-2">
        <button
          type="button"
          onClick={onAddWorkspace}
          className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-[0.75rem] text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
        >
          <span className="text-[0.85rem]">+</span>
          <span>Add Workspace</span>
        </button>
        <button
          type="button"
          onClick={onOpenTeams}
          className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-[0.75rem] text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-60">
            <path d="M5.5 7a2 2 0 1 0-1.999-2A2 2 0 0 0 5.5 7Zm5 1.5a1.75 1.75 0 1 0-1.749-1.75A1.75 1.75 0 0 0 10.5 8.5ZM3 12.75C3 11.231 4.481 10 6.5 10s3.5 1.231 3.5 2.75V13H3Zm7.5.25v-.25c0-.783-.24-1.516-.685-2.113.21-.09.442-.137.685-.137 1.38 0 2.5.895 2.5 2V13h-2.5Z" />
          </svg>
          <span className="flex-1 text-left">Manage Teams</span>
          <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em]">
            {teamCount}
          </span>
        </button>
        {selectedWorkspaceId !== "all" ? (
          <button
            type="button"
            onClick={onOpenWorkspaceSettings}
            className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-[0.75rem] text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-60">
              <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492ZM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0Z" />
              <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0a1.89 1.89 0 0 1-2.824 1.028c-1.578-.935-3.375.862-2.44 2.44a1.89 1.89 0 0 1-1.028 2.824c-1.79.527-1.79 3.065 0 3.592a1.89 1.89 0 0 1 1.028 2.824c-.935 1.578.862 3.375 2.44 2.44a1.89 1.89 0 0 1 2.824 1.028c.527 1.79 3.065 1.79 3.592 0a1.89 1.89 0 0 1 2.824-1.028c1.578.935 3.375-.862 2.44-2.44a1.89 1.89 0 0 1 1.028-2.824c1.79-.527 1.79-3.065 0-3.592a1.89 1.89 0 0 1-1.028-2.824c.935-1.578-.862-3.375-2.44-2.44a1.89 1.89 0 0 1-2.824-1.028ZM8 0c.463 0 .89.258 1.103.671a2.89 2.89 0 0 0 4.316 1.573c.375-.222.856-.096 1.078.279l.001.002c.222.375.096.856-.279 1.078a2.89 2.89 0 0 0-1.573 4.316c.222.375.096.856-.279 1.078l-.002.001a.786.786 0 0 1-1.078-.279 2.89 2.89 0 0 0-4.316 1.573.786.786 0 0 1-1.078.279l-.002-.001a.786.786 0 0 1-.279-1.078 2.89 2.89 0 0 0-1.573-4.316.786.786 0 0 1-.279-1.078l.001-.002a.786.786 0 0 1 1.078-.279A2.89 2.89 0 0 0 8.897.67 .786.786 0 0 1 8 0Z" />
            </svg>
            <span>Workspace Settings</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={onOpenGlobalSettings}
          className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-[0.75rem] text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-60">
            <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492ZM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0Z" />
            <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0a1.89 1.89 0 0 1-2.824 1.028c-1.578-.935-3.375.862-2.44 2.44a1.89 1.89 0 0 1-1.028 2.824c-1.79.527-1.79 3.065 0 3.592a1.89 1.89 0 0 1 1.028 2.824c-.935 1.578.862 3.375 2.44 2.44a1.89 1.89 0 0 1 2.824 1.028c.527 1.79 3.065 1.79 3.592 0a1.89 1.89 0 0 1 2.824-1.028c1.578.935 3.375-.862 2.44-2.44a1.89 1.89 0 0 1 1.028-2.824c1.79-.527 1.79-3.065 0-3.592a1.89 1.89 0 0 1-1.028-2.824c.935-1.578-.862-3.375-2.44-2.44a1.89 1.89 0 0 1-2.824-1.028ZM8 0c.463 0 .89.258 1.103.671a2.89 2.89 0 0 0 4.316 1.573c.375-.222.856-.096 1.078.279l.001.002c.222.375.096.856-.279 1.078a2.89 2.89 0 0 0-1.573 4.316c.222.375.096.856-.279 1.078l-.002.001a.786.786 0 0 1-1.078-.279 2.89 2.89 0 0 0-4.316 1.573.786.786 0 0 1-1.078.279l-.002-.001a.786.786 0 0 1-.279-1.078 2.89 2.89 0 0 0-1.573-4.316.786.786 0 0 1-.279-1.078l.001-.002a.786.786 0 0 1 1.078-.279A2.89 2.89 0 0 0 8.897.67 .786.786 0 0 1 8 0Z" />
          </svg>
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

function BadgeGroup({ badge, active }: { badge: WorkspaceBadge; active: boolean }) {
  if (badge.inProgress === 0 && badge.review === 0) {
    return null;
  }

  const badgeBase = "inline-flex items-center gap-0.5 rounded-sm px-1 py-px text-[0.58rem] font-medium";

  return (
    <span className="flex shrink-0 items-center gap-1">
      {badge.inProgress > 0 ? (
        <span
          className={cn(
            badgeBase,
            active
              ? "bg-white/20 text-white"
              : "bg-blue-500/15 text-blue-400"
          )}
        >
          IP {badge.inProgress}
        </span>
      ) : null}
      {badge.review > 0 ? (
        <span
          className={cn(
            badgeBase,
            active
              ? "bg-white/20 text-white"
              : "bg-amber-500/15 text-amber-400"
          )}
        >
          R {badge.review}
        </span>
      ) : null}
    </span>
  );
}
