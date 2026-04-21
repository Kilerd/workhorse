import { useMemo } from "react";
import type { Workspace, WorkspaceChannel } from "@workhorse/contracts";

import type { DisplayTask } from "@/lib/task-view";
import { cn } from "@/lib/utils";

interface Props {
  workspaces: Workspace[];
  allTasks: DisplayTask[];
  workspaceChannelsByWorkspaceId: Map<string, WorkspaceChannel[]>;
  agentCount: number;
  selectedWorkspaceId: string | "all";
  selectedChannelId: string | null;
  collapsed: boolean;
  onToggleCollapse(): void;
  onSelectWorkspace(id: string | "all"): void;
  onSelectChannel(workspaceId: string, channelId: string): void;
  onAddWorkspace(): void;
  onOpenAgents(): void;
  onOpenWorkspaceSettings(): void;
  onOpenGlobalSettings(): void;
}

interface WorkspaceBadge {
  inProgress: number;
  review: number;
}

const ACTIVE_TASK_COLUMNS = new Set<DisplayTask["column"]>([
  "backlog",
  "todo",
  "blocked",
  "running",
  "review"
]);

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

function WorkspaceRow({
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
        "grid w-full gap-2 rounded-[var(--radius)] border px-3 py-3 text-left transition-[border-color,background-color]",
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

function ChannelRow({
  label,
  active,
  trailing,
  onClick
}: {
  label: string;
  active: boolean;
  trailing?: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-9 w-full items-center justify-between rounded-[var(--radius)] border px-3 py-2 text-left text-[0.8rem] transition-[border-color,background-color,color]",
        active
          ? "border-[var(--border-strong)] bg-[var(--surface-soft)] text-foreground"
          : "border-transparent bg-transparent text-[var(--muted)] hover:border-border hover:bg-[var(--surface-hover)] hover:text-foreground"
      )}
    >
      <span className="truncate font-medium">{label}</span>
      {trailing ? (
        <span className="ml-3 shrink-0 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--muted)]">
          {trailing}
        </span>
      ) : null}
    </button>
  );
}

export function Sidebar({
  workspaces,
  allTasks,
  workspaceChannelsByWorkspaceId,
  agentCount,
  selectedWorkspaceId,
  selectedChannelId,
  collapsed,
  onToggleCollapse,
  onSelectWorkspace,
  onSelectChannel,
  onAddWorkspace,
  onOpenAgents,
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

  const tasksById = useMemo(() => {
    return new Map(allTasks.map((task) => [task.id, task]));
  }, [allTasks]);

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
            <p className="section-kicker">Workspace channels</p>
          </div>
          <nav className="min-h-0 overflow-y-auto p-2">
            <div className="mb-3">
              <WorkspaceRow
                title="All workspaces"
                subtitle={`${workspaces.length} repositories connected`}
                badge={allBadge}
                active={selectedWorkspaceId === "all"}
                onClick={() => onSelectWorkspace("all")}
              />
            </div>

            <div className="grid gap-3">
              {workspaces.map((workspace) => {
                const channels = workspaceChannelsByWorkspaceId.get(workspace.id) ?? [];
                const allChannel = channels.find(
                  (channel) => channel.kind === "all" && !channel.archivedAt
                );
                const taskChannels = channels
                  .filter((channel) => channel.kind === "task" && !channel.archivedAt)
                  .map((channel) => ({
                    channel,
                    task: channel.taskId ? tasksById.get(channel.taskId) ?? null : null
                  }))
                  .filter(
                    (entry): entry is { channel: WorkspaceChannel; task: DisplayTask } =>
                      entry.task !== null && ACTIVE_TASK_COLUMNS.has(entry.task.column)
                  )
                  .sort(
                    (left, right) =>
                      Date.parse(right.task.updatedAt) - Date.parse(left.task.updatedAt)
                  );

                return (
                  <div key={workspace.id} className="grid gap-1.5">
                    <WorkspaceRow
                      title={workspace.name}
                      subtitle={shortenPath(workspace.rootPath)}
                      badge={badgesByWorkspace.get(workspace.id)}
                      active={selectedWorkspaceId === workspace.id && selectedChannelId === null}
                      onClick={() => onSelectWorkspace(workspace.id)}
                    />

                    <div className="ml-3 grid gap-1 border-l border-border pl-3">
                      {allChannel ? (
                        <ChannelRow
                          label="#all"
                          trailing="chat"
                          active={selectedChannelId === allChannel.id}
                          onClick={() => onSelectChannel(workspace.id, allChannel.id)}
                        />
                      ) : null}

                      {taskChannels.map(({ channel, task }) => (
                        <ChannelRow
                          key={channel.id}
                          label={`#${channel.slug}`}
                          trailing={task.column}
                          active={selectedChannelId === channel.id}
                          onClick={() => onSelectChannel(workspace.id, channel.id)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </nav>
        </section>

        <section className="surface-card-soft px-2 py-2">
          <div className="grid gap-1">
            <ActionRow label="Add workspace" onClick={onAddWorkspace} />
            <ActionRow
              label="Agents"
              trailing={agentCount > 0 ? String(agentCount) : undefined}
              onClick={onOpenAgents}
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
