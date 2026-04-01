import { useMemo } from "react";
import type { Run, RunLogEntry, Task } from "@workhorse/contracts";

import {
  ENTRY_LABELS,
  getToolStatus,
  isCommandExecutionEntry,
  metadataEntries,
  normalizeToolTitle,
  prepareLiveLogEntries
} from "./live-log-entries";

interface Props {
  task: Task;
  activeRun: Run | null;
  viewedRun: Run | null;
  liveLog: RunLogEntry[];
  runLog: RunLogEntry[];
  isLoading?: boolean;
  showStatus?: boolean;
}

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

function renderEntryBody(entry: RunLogEntry) {
  const entryMetadata = metadataEntries(entry);

  return (
    <>
      {entryMetadata.length > 0 ? (
        <dl className="log-entry-details">
          {entryMetadata.map(([key, value]) => (
            <div key={`${entry.id}-${key}`}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <pre className="log-entry-body">{entry.text}</pre>
    </>
  );
}

function renderEntryHeader(entry: RunLogEntry, collapsible = false) {
  const toolStatus = getToolStatus(entry);
  const HeaderTag = collapsible ? "summary" : "header";

  return (
    <HeaderTag className={collapsible ? "log-entry-header log-entry-summary" : "log-entry-header"}>
      <div className="log-entry-title">
        <span className={`log-kind log-kind-${entry.kind}`}>{ENTRY_LABELS[entry.kind]}</span>
        {entry.title ? (
          <strong>{entry.kind === "tool_call" ? normalizeToolTitle(entry) : entry.title}</strong>
        ) : null}
      </div>
      <div className="log-entry-meta">
        {toolStatus ? (
          <span className={`log-entry-status-chip log-entry-status-${toolStatus.tone}`}>
            {toolStatus.label}
          </span>
        ) : null}
        {entry.stream !== "stdout" ? (
          <span className="log-stream-chip">{entry.stream}</span>
        ) : null}
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
      </div>
    </HeaderTag>
  );
}

export function LiveLog({
  task,
  activeRun,
  viewedRun,
  liveLog,
  runLog,
  isLoading = false,
  showStatus = true
}: Props) {
  const aggregatedEntries = useMemo(() => {
    return prepareLiveLogEntries([...runLog, ...liveLog]);
  }, [liveLog, runLog]);

  return (
    <div className={showStatus ? "details-body details-body-logs" : "live-log-panel"}>
      {showStatus ? (
        <section className="details-section">
          <h3>Run status</h3>
          <div className="active-run">
            <div>
              <strong>{activeRun ? activeRun.status : "idle"}</strong>
              <p>{activeRun ? activeRun.id : "No active run"}</p>
            </div>
            <div className="muted">{task.runnerType}</div>
          </div>
          {viewedRun ? (
            <p className="muted">
              Viewing {viewedRun.status} run {viewedRun.id}
            </p>
          ) : null}
          {viewedRun?.status === "canceled" && !activeRun ? (
            <p className="muted">
              This run was canceled. That usually means it was stopped manually, or the server restarted while the task was running.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="details-section details-section-log">
        <h3>Live log</h3>
        {!showStatus && viewedRun ? (
          <p className="muted">
            Viewing {viewedRun.status} run {viewedRun.id}
          </p>
        ) : null}
        {aggregatedEntries.length === 0 ? (
          isLoading ? (
            <div className="log-empty">Loading logs...</div>
          ) : (
          <div className="log-empty">
            Logs will appear here when a run starts.
          </div>
          )
        ) : (
          <div className="log-stream">
            {aggregatedEntries.map((entry) => (
              isCommandExecutionEntry(entry) ? (
                <details
                  key={entry.id}
                  className={`log-entry log-entry-${entry.kind} log-entry-collapsible`}
                >
                  {renderEntryHeader(entry, true)}
                  <div className="log-entry-content">{renderEntryBody(entry)}</div>
                </details>
              ) : (
                <article
                  key={entry.id}
                  className={`log-entry log-entry-${entry.kind}`}
                >
                  {renderEntryHeader(entry)}
                  {renderEntryBody(entry)}
                </article>
              )
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
