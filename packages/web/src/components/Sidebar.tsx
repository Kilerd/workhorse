import { useEffect, useMemo, useState } from "react";
import type { Thread, Workspace } from "@workhorse/contracts";

import type { DisplayTask } from "@/lib/task-view";
import { cn } from "@/lib/utils";

interface Props {
  workspaces: Workspace[];
  allTasks: DisplayTask[];
  workspaceThreadsByWorkspaceId: Map<string, Thread[]>;
  agentCount: number;
  selectedWorkspaceId: string | "all";
  selectedThreadId: string | null;
  collapsed: boolean;
  onToggleCollapse(): void;
  onSelectWorkspace(id: string | "all"): void;
  onSelectThread(workspaceId: string, threadId: string): void;
  onAddWorkspace(): void;
  onOpenAgents(): void;
  onOpenWorkspaceSettings(): void;
  onOpenGlobalSettings(): void;
}

interface WorkspaceBadge {
  inProgress: number;
  review: number;
}

interface WorkspaceTreeItem {
  id: string;
  label: string;
  meta?: string;
  active: boolean;
  trailing?: string;
  tone?: "accent" | "success" | "danger" | "muted";
  onClick(): void;
}

const ACTIVE_TASK_COLUMNS = new Set<DisplayTask["column"]>([
  "backlog",
  "todo",
  "blocked",
  "running",
  "review"
]);

const TASK_COLUMN_PRIORITY: Record<DisplayTask["column"], number> = {
  running: 0,
  review: 1,
  todo: 2,
  backlog: 3,
  blocked: 4,
  done: 5,
  archived: 6
};

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

function workspaceInitials(name: string): string {
  const segments = name
    .split(/[\s-]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const initials = segments.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return initials.join("") || name.slice(0, 2).toUpperCase();
}

function statusLabel(column: DisplayTask["column"]): string {
  switch (column) {
    case "running":
      return "Running";
    case "review":
      return "Review";
    case "blocked":
      return "Blocked";
    case "todo":
      return "Todo";
    case "backlog":
      return "Backlog";
    case "done":
      return "Done";
    case "archived":
      return "Archived";
  }
}

function actionChevron() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UtilityAction({
  label,
  trailing,
  onClick
}: {
  label: string;
  trailing?: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-8 items-center justify-between rounded-[8px] px-2.5 text-left text-[0.75rem] font-[510] text-[var(--muted)] transition-[background-color,color] hover:bg-[var(--surface-hover)] hover:text-foreground"
    >
      <span>{label}</span>
      <span className="flex items-center gap-2">
        {trailing ? (
          <span className="font-mono text-[0.63rem] uppercase tracking-[0.08em] text-[var(--muted)]">
            {trailing}
          </span>
        ) : null}
        {actionChevron()}
      </span>
    </button>
  );
}

function WorkspaceSignals({ badge }: { badge: WorkspaceBadge }) {
  if (badge.inProgress === 0 && badge.review === 0) {
    return null;
  }

  return (
    <span className="flex items-center gap-1">
      {badge.inProgress > 0 ? (
        <span className="inline-flex size-1.5 rounded-full bg-[var(--accent-strong)]" />
      ) : null}
      {badge.review > 0 ? (
        <span className="inline-flex size-1.5 rounded-full bg-[var(--success)]" />
      ) : null}
    </span>
  );
}

function WorkspaceHeaderRow({
  workspace,
  itemCount,
  badge,
  active,
  expanded,
  onToggle,
  onClick
}: {
  workspace: Workspace;
  itemCount: number;
  badge: WorkspaceBadge;
  active: boolean;
  expanded: boolean;
  onToggle(): void;
  onClick(): void;
}) {
  return (
    <div className="grid w-full min-w-0 grid-cols-[24px_minmax(0,1fr)] items-center gap-2">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-[7px] border font-mono text-[0.54rem] uppercase tracking-[0.08em] transition-[border-color,background-color,color]",
          expanded || active
            ? "border-[rgba(113,112,255,0.32)] bg-[rgba(113,112,255,0.14)] text-[var(--accent-strong)]"
            : "border-border bg-[var(--surface-soft)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-foreground"
        )}
        title={expanded ? "Collapse workspace" : "Expand workspace"}
      >
        {workspaceInitials(workspace.name)}
      </button>

      <button
        type="button"
        onClick={onClick}
        title={workspace.rootPath}
        className={cn(
          "flex min-h-9 w-full min-w-0 items-center justify-between gap-3 rounded-[9px] px-2.5 py-1.5 text-left transition-[background-color,color]",
          active
            ? "bg-[var(--surface-soft)] text-foreground"
            : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-foreground"
        )}
      >
        <div className="min-w-0 flex-1">
          <span className="truncate text-[0.77rem] font-[520] text-inherit">
            {workspace.name}
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
          <WorkspaceSignals badge={badge} />
          <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]">
            {itemCount}
          </span>
        </div>
      </button>
    </div>
  );
}

function WorkspaceTreeRow({
  item
}: {
  item: WorkspaceTreeItem;
}) {
  const toneClass =
    item.tone === "accent"
      ? "tone-accent"
      : item.tone === "success"
        ? "tone-success"
        : item.tone === "danger"
          ? "tone-danger"
          : "tone-muted";

  return (
    <button
      type="button"
      onClick={item.onClick}
      className={cn(
        "grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 rounded-[8px] px-2.5 py-2 text-left transition-[background-color,color]",
        item.meta ? "gap-y-0.5" : "items-center gap-y-0",
        item.active
          ? "bg-[var(--surface-soft)] text-foreground"
          : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-foreground"
      )}
    >
      <span className="min-w-0 truncate text-[0.74rem] font-[510] text-inherit">
        {item.label}
      </span>
      {item.trailing ? (
        <span
          className={cn(
            item.meta
              ? "col-start-2 row-span-2 self-start"
              : "col-start-2 row-start-1 self-center",
            "inline-flex min-h-5 shrink-0 items-center rounded-full border px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.08em]",
            toneClass
          )}
        >
          {item.trailing}
        </span>
      ) : null}
      {item.meta ? (
        <span className="min-w-0 truncate text-[0.64rem] text-[var(--muted)]">{item.meta}</span>
      ) : null}
    </button>
  );
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

export function Sidebar({
  workspaces,
  allTasks,
  workspaceThreadsByWorkspaceId,
  agentCount,
  selectedWorkspaceId,
  selectedThreadId,
  collapsed,
  onToggleCollapse,
  onSelectWorkspace,
  onSelectThread,
  onAddWorkspace,
  onOpenAgents,
  onOpenWorkspaceSettings,
  onOpenGlobalSettings
}: Props) {
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpandedWorkspaceIds((current) => {
      const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
      const next = new Set([...current].filter((workspaceId) => workspaceIds.has(workspaceId)));

      if (selectedWorkspaceId !== "all" && workspaceIds.has(selectedWorkspaceId)) {
        next.add(selectedWorkspaceId);
      } else if (next.size === 0 && workspaces[0]) {
        next.add(workspaces[0].id);
      }

      return setsEqual(current, next) ? current : next;
    });
  }, [selectedWorkspaceId, workspaces]);

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

  function toggleWorkspace(workspaceId: string) {
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  }

  if (collapsed) {
    return (
      <aside className="border-b border-border bg-background lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-3 py-3 lg:h-full lg:flex-col lg:justify-start lg:gap-3 lg:px-2.5 lg:py-3.5">
          <button
            type="button"
            onClick={() => onSelectWorkspace(selectedWorkspaceId === "all" ? "all" : selectedWorkspaceId)}
            className="grid size-9 place-items-center rounded-[10px] border border-border bg-[var(--surface-soft)] font-mono text-[0.66rem] font-[590] uppercase tracking-[0.08em] text-[var(--muted-strong)] transition-[border-color,background-color,color] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-foreground"
            title="Open workspace navigation"
          >
            WH
          </button>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="grid size-9 place-items-center rounded-[10px] border border-border bg-[var(--surface-soft)] text-[var(--muted)] transition-[border-color,background-color,color] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-foreground"
            title="Expand sidebar"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="border-b border-border bg-background lg:h-screen lg:border-b-0 lg:border-r">
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] gap-3 px-2.5 py-3">
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-border bg-[var(--surface-soft)] font-mono text-[0.63rem] font-[590] uppercase tracking-[0.08em] text-[var(--muted-strong)]">
              WH
            </div>
            <div className="grid gap-0.5">
              <span className="section-kicker">Workhorse</span>
              <span className="text-[0.8rem] font-[520] text-foreground">Workspace</span>
            </div>
          </div>

          <button
            type="button"
            onClick={onToggleCollapse}
            className="grid size-8 place-items-center rounded-[10px] border border-border bg-[var(--surface-soft)] text-[var(--muted)] transition-[border-color,background-color,color] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-foreground"
            title="Collapse sidebar"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M10 3 5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <nav className="min-h-0 overflow-y-auto px-1">
          <div className="grid gap-1">
            <button
              type="button"
              onClick={() => onSelectWorkspace("all")}
              className={cn(
                "flex min-h-8 items-center justify-between rounded-[8px] px-2.5 text-left transition-[background-color,color]",
                selectedWorkspaceId === "all"
                  ? "bg-[var(--surface-soft)] text-foreground"
                  : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-foreground"
              )}
            >
              <span className="text-[0.75rem] font-[510] text-inherit">All workspaces</span>
              <WorkspaceSignals badge={allBadge} />
            </button>

            <div className="my-1 h-px bg-[var(--border)]" />

            {workspaces.map((workspace) => {
              const threads = workspaceThreadsByWorkspaceId.get(workspace.id) ?? [];
              const coordinatorThread = threads.find((thread) => thread.kind === "coordinator");
              const taskThreadItems = threads
                .filter((thread) => thread.kind === "task" && !thread.archivedAt && thread.taskId)
                .map((thread) => ({
                  thread,
                  task: thread.taskId ? tasksById.get(thread.taskId) ?? null : null
                }))
                .filter(
                  (entry): entry is { thread: Thread; task: DisplayTask } =>
                    entry.task !== null && ACTIVE_TASK_COLUMNS.has(entry.task.column)
                )
                .sort((left, right) => {
                  const priorityDelta =
                    TASK_COLUMN_PRIORITY[left.task.column] - TASK_COLUMN_PRIORITY[right.task.column];
                  if (priorityDelta !== 0) {
                    return priorityDelta;
                  }
                  return Date.parse(right.task.updatedAt) - Date.parse(left.task.updatedAt);
                });

              const expanded = expandedWorkspaceIds.has(workspace.id);
              const workspaceItems: WorkspaceTreeItem[] = [
                ...(coordinatorThread
                  ? [
                      {
                        id: coordinatorThread.id,
                        label: "#coordinator",
                        active:
                          selectedWorkspaceId === workspace.id &&
                          selectedThreadId === coordinatorThread.id,
                        tone: "accent" as const,
                        onClick: () => onSelectThread(workspace.id, coordinatorThread.id)
                      }
                    ]
                  : []),
                ...taskThreadItems.map(({ thread, task }): WorkspaceTreeItem => ({
                  id: thread.id,
                  label: task.title,
                  meta: statusLabel(task.column),
                  active: selectedThreadId === thread.id,
                  onClick: () => onSelectThread(workspace.id, thread.id)
                }))
              ];

              return (
                <section key={workspace.id} className="grid w-full min-w-0 gap-1">
                  <WorkspaceHeaderRow
                    workspace={workspace}
                    itemCount={workspaceItems.length}
                    badge={badgesByWorkspace.get(workspace.id) ?? { inProgress: 0, review: 0 }}
                    active={selectedWorkspaceId === workspace.id}
                    expanded={expanded}
                    onToggle={() => toggleWorkspace(workspace.id)}
                    onClick={() => onSelectWorkspace(workspace.id)}
                  />

                  {expanded ? (
                    <div className="grid w-full min-w-0 gap-0.5">
                      {workspaceItems.map((item) => (
                        <WorkspaceTreeRow key={item.id} item={item} />
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </nav>

        <section className="grid gap-1 border-t border-border px-1 pt-2">
          <UtilityAction label="Add workspace" onClick={onAddWorkspace} />
          <UtilityAction
            label="Agents"
            trailing={agentCount > 0 ? String(agentCount) : undefined}
            onClick={onOpenAgents}
          />
          {selectedWorkspaceId !== "all" ? (
            <UtilityAction label="Workspace settings" onClick={onOpenWorkspaceSettings} />
          ) : null}
          <UtilityAction label="Global settings" onClick={onOpenGlobalSettings} />
        </section>
      </div>
    </aside>
  );
}
