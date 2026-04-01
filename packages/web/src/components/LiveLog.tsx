import { useEffect, useMemo, useRef, useState } from "react";
import type { Run, RunLogEntry, Task } from "@workhorse/contracts";

import {
  ENTRY_LABELS,
  getToolStatus,
  partitionLiveLogEntries,
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

function getConsoleEntryTone(entry: RunLogEntry): "agent" | "stderr" | "system" | "tool" | "stdout" {
  if (entry.stream === "stderr") {
    return "stderr";
  }

  if (entry.kind === "agent") {
    return "agent";
  }

  if (entry.kind === "tool_output") {
    return "tool";
  }

  if (entry.stream === "system") {
    return "system";
  }

  return "stdout";
}

function getConsoleEntryLabel(entry: RunLogEntry): string {
  if (entry.kind === "agent") {
    return "agent";
  }

  if (entry.kind === "tool_output") {
    return entry.stream === "stderr" ? "tool stderr" : "tool output";
  }

  return entry.stream;
}

function renderConsoleEntry(entry: RunLogEntry) {
  const tone = getConsoleEntryTone(entry);
  const title =
    entry.title && !["Agent output", "Tool output"].includes(entry.title)
      ? entry.title
      : null;

  return (
    <article key={entry.id} className={`log-console-entry log-console-entry-${tone}`}>
      <div className="log-console-entry-meta">
        <div className="log-console-entry-heading">
          <span className={`log-console-label log-console-label-${tone}`}>
            {getConsoleEntryLabel(entry)}
          </span>
          {title ? <strong>{title}</strong> : null}
        </div>
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
      </div>
      <pre className="log-console-entry-body">{entry.text}</pre>
    </article>
  );
}

function renderArchiveSection({
  title,
  description,
  entries
}: {
  title: string;
  description: string;
  entries: RunLogEntry[];
}) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <details className="log-archive">
      <summary className="log-archive-summary">
        <div className="log-archive-copy">
          <strong>{title}</strong>
          <p>{description}</p>
        </div>
        <span className="log-stream-chip">{entries.length} items</span>
      </summary>
      <div className="log-archive-list">
        {entries.map((entry) => (
          <details
            key={entry.id}
            className={`log-entry log-entry-${entry.kind} log-entry-collapsible log-archive-entry`}
          >
            {renderEntryHeader(entry, true)}
            <div className="log-entry-content">{renderEntryBody(entry)}</div>
          </details>
        ))}
      </div>
    </details>
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
  const { streamEntries, activeEntries, completedToolEntries, systemEntries } = useMemo(() => {
    return partitionLiveLogEntries(aggregatedEntries);
  }, [aggregatedEntries]);
  const streamRef = useRef<HTMLDivElement>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const streamTailKey = useMemo(() => {
    const lastEntry = streamEntries.at(-1);
    if (!lastEntry) {
      return "empty";
    }

    return `${lastEntry.id}:${lastEntry.timestamp}:${lastEntry.text.length}`;
  }, [streamEntries]);

  useEffect(() => {
    setIsPinnedToBottom(true);
  }, [viewedRun?.id]);

  useEffect(() => {
    const node = streamRef.current;
    if (!node || !isPinnedToBottom) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [isPinnedToBottom, streamTailKey]);

  function handleStreamScroll() {
    const node = streamRef.current;
    if (!node) {
      return;
    }

    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setIsPinnedToBottom(distanceFromBottom < 32);
  }

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
              This run was canceled. That usually means it was stopped manually before completion.
            </p>
          ) : null}
          {viewedRun?.status === "interrupted" && !activeRun ? (
            <p className="muted">
              {task.runnerType === "codex"
                ? "This run was interrupted while Workhorse was offline. Starting the task again will resume the previous Codex session when possible."
                : "This run was interrupted while Workhorse was offline. Start the task again to continue the work."}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="details-section details-section-log">
        <div className="log-summary-bar">
          <div className="log-summary-copy">
            <h3>Live log</h3>
            {!showStatus && viewedRun ? (
              <p className="muted">
                Viewing {viewedRun.status} run {viewedRun.id}
              </p>
            ) : null}
          </div>
          {aggregatedEntries.length > 0 ? (
            <div className="log-summary-chips">
              {streamEntries.length > 0 ? (
                <span className="meta-chip">{streamEntries.length} stream</span>
              ) : null}
              {activeEntries.length > 0 ? (
                <span className="meta-chip meta-chip-status">{activeEntries.length} active</span>
              ) : null}
              {completedToolEntries.length > 0 ? (
                <span className="meta-chip">{completedToolEntries.length} done</span>
              ) : null}
              {systemEntries.length > 0 ? (
                <span className="meta-chip">{systemEntries.length} system</span>
              ) : null}
            </div>
          ) : null}
        </div>
        {aggregatedEntries.length === 0 ? (
          isLoading ? (
            <div className="log-empty">Loading logs...</div>
          ) : (
            <div className="log-empty">
              Logs will appear here when a run starts.
            </div>
          )
        ) : (
          <div className="log-stack">
            {activeEntries.length > 0 ? (
              <div className="log-group">
                <div className="log-group-header">
                  <p className="log-group-title">Current activity</p>
                </div>
                <div className="log-activity-lane">
                  {activeEntries.map((entry) => (
                    <article
                      key={entry.id}
                      className={`log-entry log-entry-${entry.kind} log-activity-card`}
                    >
                      {renderEntryHeader(entry)}
                      <div className="log-entry-content">{renderEntryBody(entry)}</div>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="log-group">
              <div className="log-group-header">
                <p className="log-group-title">Output stream</p>
                {streamEntries.length > 0 && !isPinnedToBottom ? (
                  <span className="log-stream-chip">Scroll paused</span>
                ) : null}
              </div>
              {streamEntries.length > 0 ? (
                <div
                  ref={streamRef}
                  className="log-console"
                  onScroll={handleStreamScroll}
                >
                  {streamEntries.map((entry) => renderConsoleEntry(entry))}
                </div>
              ) : (
                <div className="log-empty">
                  {activeEntries.length > 0
                    ? "Structured run events are listed above. Console output will appear here when the runner prints something."
                    : "This run did not emit stdout or stderr output."}
                </div>
              )}
            </div>

            {renderArchiveSection({
              title: "Completed steps",
              description: "Finished tool calls are tucked away here so the live stream stays readable.",
              entries: completedToolEntries
            })}

            {renderArchiveSection({
              title: "System notices",
              description: "Runner bootstrap and infrastructure chatter from the underlying session.",
              entries: systemEntries
            })}
          </div>
        )}
      </section>
    </div>
  );
}
