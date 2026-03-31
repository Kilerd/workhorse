import { useEffect, useMemo, useState } from "react";
import type { Run, Workspace } from "@workhorse/contracts";

import { formatRelativeTime } from "@/lib/format";
import type { DisplayTask } from "@/lib/task-view";
import { LiveLog } from "./LiveLog";
import { TaskActionBar } from "./TaskActionBar";

interface Props {
  className?: string;
  task: DisplayTask | null;
  runs: Run[];
  workspaces: Workspace[];
  selectedRunId: string | null;
  onSelectRun(runId: string): void;
  liveLog: string;
  runLog: string;
  onPlan(): void;
  onStart(): void;
  onStop(): void;
  onMoveToTodo(): void;
  onMarkDone(): void;
  onArchive(): void;
  onDelete(): void;
}

export function TaskDetailsPanel({
  className,
  task,
  runs,
  workspaces,
  selectedRunId,
  onSelectRun,
  liveLog,
  runLog,
  onPlan,
  onStart,
  onStop,
  onMoveToTodo,
  onMarkDone,
  onArchive,
  onDelete
}: Props) {
  const [tab, setTab] = useState<"overview" | "logs">("overview");

  useEffect(() => {
    setTab("overview");
  }, [task?.id]);

  const activeRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs.find((run) => run.status === "running") ?? runs[0] ?? null,
    [runs, selectedRunId]
  );

  if (!task) {
    return (
      <aside className={["details-panel", className, "empty-panel"].filter(Boolean).join(" ")}>
        <div className="empty-state">
          <p className="eyebrow">Task details</p>
          <h2>Select a card</h2>
          <p>Card details, run history and live logs will appear here.</p>
        </div>
      </aside>
    );
  }

  const workspaceName = workspaces.find((workspace) => workspace.id === task.workspaceId)?.name ?? "Unknown";

  return (
    <aside className={["details-panel", className].filter(Boolean).join(" ")}>
      <div className="details-header">
        <div>
          <p className="eyebrow">Task details</p>
          <h2>{task.title}</h2>
          <p className="details-subtitle">{workspaceName}</p>
        </div>
        <div className="details-actions">
          <TaskActionBar
            column={task.column}
            onPlan={onPlan}
            onStart={onStart}
            onStop={onStop}
            onMoveToTodo={onMoveToTodo}
            onMarkDone={onMarkDone}
            onArchive={onArchive}
          />
          <button type="button" className="button button-danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>

      <div className="details-tabs">
        <button
          type="button"
          className={tab === "overview" ? "tab tab-active" : "tab"}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={tab === "logs" ? "tab tab-active" : "tab"}
          onClick={() => setTab("logs")}
        >
          Logs
        </button>
      </div>

      {tab === "overview" ? (
        <div className="details-body">
          <dl className="details-grid">
            <div>
              <dt>Status</dt>
              <dd>{task.column}</dd>
            </div>
            <div>
              <dt>Runner</dt>
              <dd>{task.runnerType}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatRelativeTime(task.updatedAt)}</dd>
            </div>
            <div>
              <dt>Last run</dt>
              <dd>{task.lastRunId ?? "none"}</dd>
            </div>
          </dl>
          <section className="details-section">
            <h3>Description</h3>
            <p className="details-description">{task.description || "No description yet."}</p>
          </section>
          <section className="details-section">
            <h3>Runs</h3>
            <div className="run-list">
              {runs.length === 0 ? (
                <p className="muted">No runs yet.</p>
              ) : (
                runs.map((run) => (
                  <button
                    type="button"
                    key={run.id}
                    className={run.id === activeRun?.id ? "run-row run-row-active" : "run-row"}
                    onClick={() => onSelectRun(run.id)}
                  >
                    <span>{run.status}</span>
                    <span>{formatRelativeTime(run.startedAt)}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      ) : (
        <LiveLog
          task={task}
          activeRun={activeRun}
          liveLog={liveLog}
          runLog={runLog}
        />
      )}
    </aside>
  );
}
