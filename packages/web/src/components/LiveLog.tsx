import { useEffect, useMemo, useRef, useState } from "react";
import type { Run, RunLogEntry, Task } from "@workhorse/contracts";

import {
  buildLiveLogStreamItems,
  ENTRY_LABELS,
  getToolStatus,
  isCommandExecutionEntry,
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

function getConsoleEntryTone(
  entry: RunLogEntry
): "agent" | "plan" | "status" | "stderr" | "system" | "tool" | "stdout" {
  if (entry.stream === "stderr") {
    return "stderr";
  }

  if (entry.kind === "tool_call" || entry.kind === "tool_output") {
    return "tool";
  }

  if (entry.kind === "agent") {
    return "agent";
  }

  if (entry.kind === "plan") {
    return "plan";
  }

  if (entry.kind === "status") {
    return "status";
  }

  if (entry.stream === "system") {
    return "system";
  }

  return "stdout";
}

function getConsoleEntryLabel(entry: RunLogEntry): string {
  if (entry.kind === "tool_call") {
    return "tool";
  }

  if (entry.kind === "agent") {
    return "agent";
  }

  if (entry.kind === "tool_output") {
    return entry.stream === "stderr" ? "tool stderr" : "tool output";
  }

  if (entry.kind === "plan") {
    return "plan";
  }

  if (entry.kind === "status") {
    return "status";
  }

  return entry.stream;
}

function renderConsoleEntry(entry: RunLogEntry) {
  const tone = getConsoleEntryTone(entry);
  const toolStatus = getToolStatus(entry);
  const title =
    entry.kind === "tool_call"
      ? normalizeToolTitle(entry)
      : entry.title && !["Agent output", "Tool output"].includes(entry.title)
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
          {toolStatus ? (
            <span className={`log-entry-status-chip log-entry-status-${toolStatus.tone}`}>
              {toolStatus.label}
            </span>
          ) : null}
        </div>
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
      </div>
      <pre className="log-console-entry-body">{entry.text}</pre>
    </article>
  );
}

function renderToolOutputEntry(entry: RunLogEntry) {
  const tone = getConsoleEntryTone(entry);

  return (
    <article key={entry.id} className={`log-tool-output-entry log-tool-output-entry-${tone}`}>
      <div className="log-tool-output-meta">
        <span className={`log-console-label log-console-label-${tone}`}>
          {getConsoleEntryLabel(entry)}
        </span>
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
      </div>
      <pre className="log-console-entry-body">{entry.text}</pre>
    </article>
  );
}

function summarizeToolPreview(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function renderToolStreamItem(entry: RunLogEntry, outputEntries: RunLogEntry[]) {
  const toolStatus = getToolStatus(entry);
  const isCommandExecution = isCommandExecutionEntry(entry);
  const preview = summarizeToolPreview(entry.text);

  if (isCommandExecution) {
    return (
      <details key={entry.id} className="log-tool-stream-item log-tool-stream-item-collapsible">
        <summary className="log-tool-stream-summary">
          <div className="log-console-entry-meta">
            <div className="log-console-entry-heading">
              <span className="log-console-label log-console-label-tool">tool</span>
              <strong>{normalizeToolTitle(entry)}</strong>
              {toolStatus ? (
                <span className={`log-entry-status-chip log-entry-status-${toolStatus.tone}`}>
                  {toolStatus.label}
                </span>
              ) : null}
            </div>
            <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
          </div>
          {preview ? <code className="log-tool-preview">{preview}</code> : null}
        </summary>

        <div className="log-tool-body">{renderEntryBody(entry)}</div>

        {outputEntries.length > 0 ? (
          <details className="log-tool-output-toggle">
            <summary className="log-tool-output-summary">
              <span className="log-console-label log-console-label-tool">tool output</span>
              <span>{outputEntries.length} block{outputEntries.length > 1 ? "s" : ""}</span>
            </summary>
            <div className="log-tool-output-list">
              {outputEntries.map((outputEntry) => renderToolOutputEntry(outputEntry))}
            </div>
          </details>
        ) : null}
      </details>
    );
  }

  return (
    <article key={entry.id} className="log-tool-stream-item">
      <div className="log-console-entry-meta">
        <div className="log-console-entry-heading">
          <span className="log-console-label log-console-label-tool">tool</span>
          <strong>{normalizeToolTitle(entry)}</strong>
          {toolStatus ? (
            <span className={`log-entry-status-chip log-entry-status-${toolStatus.tone}`}>
              {toolStatus.label}
            </span>
          ) : null}
        </div>
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
      </div>

      <div className="log-tool-body">{renderEntryBody(entry)}</div>

      {outputEntries.length > 0 ? (
        <details className="log-tool-output-toggle">
          <summary className="log-tool-output-summary">
            <span className="log-console-label log-console-label-tool">tool output</span>
            <span>{outputEntries.length} block{outputEntries.length > 1 ? "s" : ""}</span>
          </summary>
          <div className="log-tool-output-list">
            {outputEntries.map((outputEntry) => renderToolOutputEntry(outputEntry))}
          </div>
        </details>
      ) : null}
    </article>
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
  const { streamEntries } = useMemo(() => {
    return partitionLiveLogEntries(aggregatedEntries);
  }, [aggregatedEntries]);
  const streamItems = useMemo(() => {
    return buildLiveLogStreamItems(streamEntries);
  }, [streamEntries]);
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
                  {streamItems.map((item) =>
                    item.type === "tool"
                      ? renderToolStreamItem(item.entry, item.outputEntries)
                      : renderConsoleEntry(item.entry)
                  )}
                </div>
              ) : (
                <div className="log-empty">
                  This run did not emit output.
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
