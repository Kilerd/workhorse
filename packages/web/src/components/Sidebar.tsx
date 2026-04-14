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
    ? tasks.filter((task) => task.workspaceId === workspaceId)
    : tasks;

  return {
    inProgress: filtered.filter((task) => task.column === "running").length,
    review: filtered.filter((task) => task.column === "review").length
  };
}

function shortenPath(rootPath: string): string {
  const parts = rootPath.replace(/\/$/, "").split("/");
  if (parts.length <= 2) {
    return rootPath;
  }

  return `~/${parts.slice(-1)[0]}`;
}

function ActionRow({
  label,
  onClick,
  trailing
}: {
  label: string;
  onClick(): void;
  trailing?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-10 items-center justify-between rounded-[var(--radius)] border border-transparent px-3 text-left text-[0.86rem] font-medium text-[var(--muted)] transition-[border-color,background-color,color] hover:border-border hover:bg-[var(--surface-hover)] hover:text-foreground"
    >
      <span>{label}</span>
      <span className="flex items-center gap-2">
        {trailing ? (
          <span className="font-mono text-[0.68rem] uppercase tracking-[0.08em] text-[var(--muted)]">
            {trailing}
          </span>
        ) : null}
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  );
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
    for (const workspace of workspaces) {
      map.set(workspace.id, computeBadges(allTasks, workspace.id));
    }
    return map;
  }, [workspaces, allTasks]);

  const allBadge = useMemo(() => computeBadges(allTasks, null), [allTasks]);

  if (collapsed) {
    return (
      <aside className="border-b border-border bg-background lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-4 py-4 lg:h-full lg:flex-col lg:justify-start lg:px-3 lg:py-4">
          <div className="grid size-10 place-items-center rounded-full border border-border bg-[var(--panel)] font-display text-[0.95rem]">
            WH
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="grid size-10 place-items-center rounded-full border border-border bg-[var(--panel)] text-[var(--muted)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-foreground"
            title="Expand sidebar"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 3l5 5-5 5" />
            </svg>
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="border-b border-border bg-background lg:h-screen lg:border-b-0 lg:border-r">
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-4 py-4">
        <div className="flex items-center justify-between">
          <span className="text-[1rem] font-semibold">Workhorse</span>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="grid size-8 place-items-center rounded-full border border-border bg-[var(--panel)] text-[var(--muted)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-foreground"
            title="Collapse sidebar"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M10 3 5 8l5 5" />
            </svg>
          </button>
        </div>

        <section className="surface-card grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <p className="section-kicker">Workspaces</p>
          </div>
          <nav className="min-h-0 overflow-y-auto p-2">
            <WorkspaceButton
              title="All workspaces"
              subtitle={`${workspaces.length} repositories connected`}
              badge={allBadge}
              active={selectedWorkspaceId === "all"}
              onClick={() => onSelectWorkspace("all")}
            />
            {workspaces.map((workspace) => (
              <WorkspaceButton
                key={workspace.id}
                title={workspace.name}
                subtitle={shortenPath(workspace.rootPath)}
                badge={badgesByWorkspace.get(workspace.id)}
                active={selectedWorkspaceId === workspace.id}
                onClick={() => onSelectWorkspace(workspace.id)}
              />
            ))}
          </nav>
        </section>

        <section className="surface-card-soft px-2 py-2">
          <div className="grid gap-1">
            <ActionRow label="Add workspace" onClick={onAddWorkspace} />
            <ActionRow
              label="Manage teams"
              trailing={teamCount > 0 ? String(teamCount) : undefined}
              onClick={onOpenTeams}
            />
            {selectedWorkspaceId !== "all" ? (
              <ActionRow label="Workspace settings" onClick={onOpenWorkspaceSettings} />
            ) : null}
            <ActionRow label="Global settings" onClick={onOpenGlobalSettings} />
          </div>
        </section>
      </div>
    </aside>
  );
}

function WorkspaceButton({
  title,
  subtitle,
  badge,
  active,
  onClick
}: {
  title: string;
  subtitle: string;
  badge?: WorkspaceBadge;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "mb-2 grid w-full gap-2 rounded-[var(--radius)] border px-3 py-3 text-left transition-[border-color,background-color]",
        active
          ? "border-[var(--border-strong)] bg-[var(--surface-soft)]"
          : "border-transparent bg-transparent hover:border-border hover:bg-[var(--surface-hover)]"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 text-[0.9rem] font-semibold leading-[1.35] text-foreground">
          {title}
        </span>
        {badge ? <BadgeGroup badge={badge} active={active} /> : null}
      </div>
      <span className="truncate text-[0.74rem] text-[var(--muted)]">{subtitle}</span>
    </button>
  );
}

function BadgeGroup({ badge, active }: { badge: WorkspaceBadge; active: boolean }) {
  if (badge.inProgress === 0 && badge.review === 0) {
    return null;
  }

  return (
    <span className="flex shrink-0 items-center gap-1">
      {badge.inProgress > 0 ? (
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[0.66rem] font-semibold",
            active
              ? "border-[rgba(255,79,0,0.22)] bg-[rgba(255,79,0,0.08)] text-[var(--accent-strong)]"
              : "border-border bg-[var(--panel)] text-[var(--muted)]"
          )}
        >
          Run {badge.inProgress}
        </span>
      ) : null}
      {badge.review > 0 ? (
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[0.66rem] font-semibold",
            active
              ? "border-[rgba(47,117,88,0.24)] bg-[rgba(47,117,88,0.08)] text-[var(--success)]"
              : "border-border bg-[var(--panel)] text-[var(--muted)]"
          )}
        >
          Review {badge.review}
        </span>
      ) : null}
    </span>
  );
}
