import { useEffect, useMemo, useState } from "react";
import type { Run, Task, Workspace } from "@workhorse/contracts";

import { formatRelativeTime } from "@/lib/format";
import { LiveLog } from "./LiveLog";

interface Props {
  task: Task | null;
  runs: Run[];
  workspaces: Workspace[];
  selectedRunId: string | null;
  onSelectRun(runId: string): void;
  liveLog: string;
  runLog: string;
  onStart(): void;
  onStop(): void;
  onDelete(): void;
}

export function TaskDetailsPanel({
  task,
  runs,
  workspaces,
  selectedRunId,
  onSelectRun,
  liveLog,
  runLog,
  onStart,
  onStop,
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
      <aside className="details-panel empty-panel">
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
    <aside className="details-panel">
      <div className="details-header">
        <div>
          <p className="eyebrow">Task details</p>
          <h2>{task.title}</h2>
          <p className="details-subtitle">{workspaceName}</p>
        </div>
        <div className="details-actions">
          <button type="button" className="button button-secondary" onClick={onStart}>
            Start
          </button>
          <button type="button" className="button button-secondary" onClick={onStop}>
            Stop
          </button>
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
