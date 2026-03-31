import { useMemo } from "react";
import type { Run, RunLogEntry, Task } from "@workhorse/contracts";

interface Props {
  task: Task;
  activeRun: Run | null;
  liveLog: RunLogEntry[];
  runLog: RunLogEntry[];
}

const ENTRY_LABELS: Record<RunLogEntry["kind"], string> = {
  text: "Output",
  agent: "Agent",
  tool_call: "Tool",
  tool_output: "Tool Output",
  plan: "Plan",
  system: "System",
  status: "Status"
};

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function LiveLog({ task, activeRun, liveLog, runLog }: Props) {
  const entries = useMemo(() => {
    const merged = [...runLog, ...liveLog];
    const seen = new Set<string>();

    return merged
      .filter((entry) => {
        if (seen.has(entry.id)) {
          return false;
        }
        seen.add(entry.id);
        return true;
      })
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }, [liveLog, runLog]);

  return (
    <div className="details-body">
      <section className="details-section">
        <h3>Current run</h3>
        <div className="active-run">
          <div>
            <strong>{activeRun ? activeRun.status : "idle"}</strong>
            <p>{activeRun ? activeRun.id : "No active run"}</p>
          </div>
          <div className="muted">{task.runnerType}</div>
        </div>
      </section>
      <section className="details-section">
        <h3>Live log</h3>
        {entries.length === 0 ? (
          <div className="log-empty">
            Logs will appear here when a run starts.
          </div>
        ) : (
          <div className="log-stream">
            {entries.map((entry) => (
              <article
                key={entry.id}
                className={`log-entry log-entry-${entry.kind}`}
              >
                <header className="log-entry-header">
                  <div className="log-entry-title">
                    <span className={`log-kind log-kind-${entry.kind}`}>
                      {ENTRY_LABELS[entry.kind]}
                    </span>
                    {entry.title ? <strong>{entry.title}</strong> : null}
                  </div>
                  <div className="log-entry-meta">
                    {entry.stream !== "stdout" ? (
                      <span className="log-stream-chip">{entry.stream}</span>
                    ) : null}
                    <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
                  </div>
                </header>
                {entry.metadata && Object.keys(entry.metadata).length > 0 ? (
                  <dl className="log-entry-details">
                    {Object.entries(entry.metadata).map(([key, value]) => (
                      <div key={`${entry.id}-${key}`}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <pre className="log-entry-body">{entry.text}</pre>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
