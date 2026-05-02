import { useEffect, useMemo, useState } from "react";
import type { Run, Thread, Workspace, WorkspaceAgent } from "@workhorse/contracts";

import type { DisplayTask } from "@/lib/task-view";
import { cn } from "@/lib/utils";

import { TaskDetailHeader } from "./TaskDetailHeader";
import { TaskTabs, isTaskDetailTab, type TaskDetailTab } from "./TaskTabs";
import { OverviewTab } from "./task-detail/OverviewTab";
import { CodingTab } from "./task-detail/CodingTab";
import { ReviewTab } from "./task-detail/ReviewTab";
import { FilesTab } from "./task-detail/FilesTab";

interface Props {
  className?: string;
  task: DisplayTask | null;
  allTasks: DisplayTask[];
  runs: Run[];
  workspaces: Workspace[];
  workspaceAgents: WorkspaceAgent[];
  thread: Thread | null;
  onBack?(): void;
  onApproveSubtask?(): void;
  onRejectSubtask?(reason?: string): void;
  onRetrySubtask?(): void;
  onCancelSubtask?(): void;
  reviewActionBusy?: boolean;
  onStop(): void;
  onMoveToTodo(): void;
  onMarkDone(): void;
  onArchive(): void;
  onCleanupWorktree(): void;
  onDelete(): void;
  onSetDependencies(ids: string[]): void;
}

const detailPanelClass = "grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] bg-transparent";
const emptyStateClass = "surface-card grid max-w-[34rem] gap-4 px-8 py-10 text-center";

function readActiveTabFromHash(): TaskDetailTab | null {
  if (typeof window === "undefined") {
    return null;
  }
  const hash = window.location.hash.replace(/^#/, "");
  return isTaskDetailTab(hash) ? hash : null;
}

function defaultTab(task: DisplayTask, runs: Run[]): TaskDetailTab {
  if (task.column === "review" || task.column === "done") {
    return "review";
  }
  if (runs.length > 0 || task.column === "running" || task.column === "todo") {
    return "coding";
  }
  return "overview";
}

export function TaskDetailsPanel({
  className,
  task,
  allTasks,
  runs,
  workspaces,
  workspaceAgents,
  thread,
  onBack,
  onApproveSubtask,
  onRejectSubtask,
  onRetrySubtask,
  onCancelSubtask,
  reviewActionBusy,
  onStop,
  onMoveToTodo,
  onMarkDone,
  onArchive,
  onCleanupWorktree,
  onDelete,
  onSetDependencies
}: Props) {
  const [activeTab, setActiveTab] = useState<TaskDetailTab>(() => {
    const fromHash = readActiveTabFromHash();
    if (fromHash) return fromHash;
    return task ? defaultTab(task, runs) : "overview";
  });

  const taskId = task?.id ?? null;

  useEffect(() => {
    if (!task) return;
    const fromHash = readActiveTabFromHash();
    setActiveTab(fromHash ?? defaultTab(task, runs));
    // re-evaluate on task change only — runs drift is fine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHashChange = () => {
      const next = readActiveTabFromHash();
      if (next) setActiveTab(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const handleTabChange = (next: TaskDetailTab) => {
    setActiveTab(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.hash = next;
      window.history.replaceState(window.history.state, "", url.toString());
    }
  };

  const workspace = useMemo(
    () => workspaces.find((entry) => entry.id === task?.workspaceId) ?? null,
    [workspaces, task?.workspaceId]
  );

  if (!task) {
    return (
      <aside className={cn(detailPanelClass, "place-items-center", className)}>
        <div className={emptyStateClass}>
          <p className="section-kicker m-0">Task details</p>
          <h2 className="text-[2.4rem]">Select a task</h2>
          <p className="m-0 text-[1rem] leading-[1.6] text-[var(--muted)]">
            Task context, conversations and diff will appear here.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={cn(detailPanelClass, className)}>
      <TaskDetailHeader
        task={task}
        workspace={workspace}
        workspaceAgents={workspaceAgents}
        onBack={onBack}
        onStop={onStop}
        onMoveToTodo={onMoveToTodo}
        onMarkDone={onMarkDone}
        onArchive={onArchive}
        onDelete={onDelete}
        onApproveSubtask={onApproveSubtask}
        onRejectSubtask={onRejectSubtask}
        onRetrySubtask={onRetrySubtask}
        onCancelSubtask={onCancelSubtask}
        reviewActionBusy={reviewActionBusy}
      />

      <TaskTabs active={activeTab} onChange={handleTabChange} />

      <div className="min-h-0 overflow-hidden">
        {activeTab === "overview" ? (
          <div className="h-full overflow-y-auto">
            <OverviewTab
              task={task}
              allTasks={allTasks}
              workspace={workspace}
              workspaceAgents={workspaceAgents}
              onSetDependencies={onSetDependencies}
              onCleanupWorktree={onCleanupWorktree}
            />
          </div>
        ) : null}

        {activeTab === "coding" ? (
          <div className="flex h-full min-h-0 flex-col px-4 py-3 sm:px-5">
            <CodingTab task={task} thread={thread} runs={runs} />
          </div>
        ) : null}

        {activeTab === "review" ? (
          <div className="flex h-full min-h-0 flex-col px-4 py-3 sm:px-5">
            <ReviewTab task={task} thread={thread} runs={runs} />
          </div>
        ) : null}

        {activeTab === "files" ? (
          <div className="flex h-full min-h-0 flex-col">
            <FilesTab task={task} />
          </div>
        ) : null}
      </div>
    </aside>
  );
}
