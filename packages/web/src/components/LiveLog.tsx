import { useEffect, useMemo, useRef, useState } from "react";
import type { Run, RunLogEntry, Task } from "@workhorse/contracts";
import type { LiveLogCommandExecutionGroupStreamItem } from "./live-log-entries";

import {
  buildLiveLogStreamItems,
  ENTRY_LABELS,
  getToolStatus,
  groupLiveLogStreamItems,
  isCommandExecutionEntry,
  parseStickyPlanContent,
  partitionLiveLogEntries,
  metadataEntries,
  normalizeToolTitle,
  prepareLiveLogEntries
} from "./live-log-entries";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  task: Task;
  activeRun: Run | null;
  viewedRun: Run | null;
  liveLog: RunLogEntry[];
  runLog: RunLogEntry[];
  isLoading?: boolean;
  showStatus?: boolean;
  canSendInput?: boolean;
  inputMode?: "running" | "review" | null;
  onSendInput?(text: string): Promise<unknown>;
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

function buildCopyPayload(entries: RunLogEntry[]): string {
  return entries
    .map((entry) => {
      const title =
        entry.kind === "tool_call"
          ? normalizeToolTitle(entry)
          : entry.title && !["Agent output", "Tool output"].includes(entry.title)
            ? entry.title
            : null;
      const toolStatus = getToolStatus(entry);
      const metadata = [
        formatTimestamp(entry.timestamp),
        ENTRY_LABELS[entry.kind],
        title,
        toolStatus?.label,
        entry.stream !== "stdout" ? entry.stream : null
      ]
        .filter(Boolean)
        .join(" | ");

      return `${metadata}\n${entry.text}`.trim();
    })
    .join("\n\n");
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
): "agent" | "plan" | "status" | "stderr" | "system" | "tool" | "user" | "stdout" {
  if (entry.stream === "stderr") {
    return "stderr";
  }

  if (entry.kind === "tool_call" || entry.kind === "tool_output") {
    return "tool";
  }

  if (entry.kind === "agent") {
    return "agent";
  }

  if (entry.kind === "user") {
    return "user";
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

  if (entry.kind === "user") {
    return "user";
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

function formatTimestampRange(start: string, end: string): string {
  const startLabel = formatTimestamp(start);
  const endLabel = formatTimestamp(end);
  if (!startLabel || !endLabel || startLabel === endLabel) {
    return endLabel || startLabel;
  }

  return `${startLabel} - ${endLabel}`;
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

function renderCommandExecutionGroup(item: LiveLogCommandExecutionGroupStreamItem) {
  const firstEntry = item.items[0]?.entry;
  const lastEntry = item.items.at(-1)?.entry;
  if (!firstEntry || !lastEntry) {
    return null;
  }

  const commandLabel =
    item.items.length === 1
      ? "1 Command Execution"
      : `${item.items.length} Command Executions`;

  return (
    <details
      key={`${firstEntry.id}-${lastEntry.id}`}
      className="log-command-execution-group"
    >
      <summary className="log-command-execution-group-summary">
        <div className="log-console-entry-meta">
          <div className="log-console-entry-heading">
            <span className="log-console-label log-console-label-tool">tool</span>
            <strong>{commandLabel}</strong>
          </div>
          <span className="log-command-execution-group-range">
            {formatTimestampRange(firstEntry.timestamp, lastEntry.timestamp)}
          </span>
        </div>
      </summary>

      <div className="log-command-execution-group-body">
        {item.items.map(({ entry, outputEntries }) =>
          renderToolStreamItem(entry, outputEntries)
        )}
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
  showStatus = true,
  canSendInput = false,
  inputMode = null,
  onSendInput
}: Props) {
  const aggregatedEntries = useMemo(() => {
    return prepareLiveLogEntries([...runLog, ...liveLog]);
  }, [liveLog, runLog]);
  const { streamEntries, stickyPlanEntry } = useMemo(() => {
    return partitionLiveLogEntries(aggregatedEntries);
  }, [aggregatedEntries]);
  const stickyPlan = useMemo(() => {
    return stickyPlanEntry ? parseStickyPlanContent(stickyPlanEntry.text) : null;
  }, [stickyPlanEntry]);
  const streamItems = useMemo(() => {
    return buildLiveLogStreamItems(streamEntries);
  }, [streamEntries]);
  const displayItems = useMemo(() => {
    return groupLiveLogStreamItems(streamItems);
  }, [streamItems]);
  const streamRef = useRef<HTMLDivElement>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [draft, setDraft] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "sending" | "failed">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
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
    setDraft("");
    setSubmitState("idle");
    setSubmitError(null);
  }, [inputMode, viewedRun?.id]);

  useEffect(() => {
    const node = streamRef.current;
    if (!node || !isPinnedToBottom) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [isPinnedToBottom, streamTailKey]);

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopyState("idle");
    }, 1600);

    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  function handleStreamScroll() {
    const node = streamRef.current;
    if (!node) {
      return;
    }

    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setIsPinnedToBottom(distanceFromBottom < 32);
  }

  async function handleCopyLog() {
    if (streamEntries.length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(buildCopyPayload(streamEntries));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  async function handleSendInput() {
    const text = draft.trim();
    if (!text || !canSendInput || !onSendInput) {
      return;
    }

    setSubmitState("sending");
    setSubmitError(null);

    try {
      await onSendInput(text);
      setDraft("");
      setSubmitState("idle");
    } catch (error) {
      setSubmitState("failed");
      setSubmitError(error instanceof Error ? error.message : "Unable to send input.");
    }
  }

  const hasVisibleEntries = Boolean(stickyPlanEntry) || streamEntries.length > 0;
  const inputAssistText =
    inputMode === "running"
      ? "Send a steering message into the active Codex run."
      : inputMode === "review"
        ? "Resume the latest Codex thread from review and continue in the same conversation."
        : null;

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
        <div className={showStatus ? "log-summary-bar" : "task-detail-log-header"}>
          <div className={showStatus ? "log-summary-copy" : "task-detail-log-header-copy"}>
            <h3>Live log</h3>
            {streamEntries.length > 0 ? (
              <span
                className="task-detail-log-count"
                aria-label={`${streamEntries.length} stream entries`}
                title={`${streamEntries.length} stream entries`}
              >
                {streamEntries.length}
              </span>
            ) : null}
          </div>
          {streamEntries.length > 0 ? (
            <button
              type="button"
              className="task-detail-copy-button"
              onClick={() => {
                void handleCopyLog();
              }}
            >
              <CopyIcon />
              <span>
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "failed"
                    ? "Retry copy"
                    : "Copy"}
              </span>
            </button>
          ) : null}
        </div>
        {!showStatus && viewedRun ? (
          <div className="task-detail-log-context">
            Viewing {viewedRun.status} run{" "}
            <code className="task-detail-log-context-code">{viewedRun.id}</code>
          </div>
        ) : null}
        {aggregatedEntries.length === 0 ? (
          isLoading ? (
            <div className="log-empty">Loading logs...</div>
          ) : (
            <div className="log-empty">
              Logs will appear here when a run starts.
            </div>
          )
        ) : !hasVisibleEntries ? (
          <div className="log-empty">Waiting for meaningful output.</div>
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
                  {stickyPlanEntry && stickyPlan ? (
                    <StickyPlanCard entry={stickyPlanEntry} plan={stickyPlan} />
                  ) : null}
                  {displayItems.map((item) => {
                    if (item.type === "command_execution_group") {
                      return renderCommandExecutionGroup(item);
                    }

                    return item.type === "tool"
                      ? renderToolStreamItem(item.entry, item.outputEntries)
                      : renderConsoleEntry(item.entry);
                  })}
                </div>
              ) : (
                <div className="log-console">
                  {stickyPlanEntry && stickyPlan ? (
                    <StickyPlanCard entry={stickyPlanEntry} plan={stickyPlan} />
                  ) : (
                    <div className="log-empty">This run did not emit output.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {canSendInput && onSendInput ? (
          <form
            className="log-input-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSendInput();
            }}
          >
            <div className="log-input-header">
              <div className="log-input-copy">
                <strong>{inputMode === "review" ? "Continue thread" : "Intervene live"}</strong>
                {inputAssistText ? <span>{inputAssistText}</span> : null}
              </div>
              <Button
                type="submit"
                disabled={submitState === "sending" || draft.trim().length === 0}
              >
                {submitState === "sending" ? "Sending..." : "Send"}
              </Button>
            </div>
            <label className="log-input-label">
              <span className="sr-only">Send input to Codex</span>
              <Textarea
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (submitState === "failed") {
                    setSubmitState("idle");
                    setSubmitError(null);
                  }
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void handleSendInput();
                  }
                }}
                rows={2}
                placeholder={
                  inputMode === "review"
                    ? "Describe what should change next..."
                    : "Tell the agent what to do next..."
                }
                disabled={submitState === "sending"}
              />
            </label>
            <div className="log-input-footer">
              <span>Press Ctrl/Cmd+Enter to send.</span>
              {submitError ? <span className="log-input-error">{submitError}</span> : null}
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}

function StickyPlanCard({
  entry,
  plan
}: {
  entry: RunLogEntry;
  plan: ReturnType<typeof parseStickyPlanContent>;
}) {
  const completedCount = plan.items.filter((item) => item.done).length;
  const summary =
    plan.items.length > 0
      ? `${completedCount} out of ${plan.items.length} task${
          plan.items.length === 1 ? "" : "s"
        } completed`
      : plan.summary ?? "Execution plan";

  return (
    <section className="sticky-plan-card">
      <div className="sticky-plan-card-header">
        <div className="sticky-plan-card-summary">
          <span className="sticky-plan-card-kicker">Plan</span>
          <strong>{summary}</strong>
        </div>
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
      </div>

      {plan.summary && plan.items.length > 0 ? (
        <p className="sticky-plan-card-description">{plan.summary}</p>
      ) : null}

      {plan.items.length > 0 ? (
        <ol className="sticky-plan-list">
          {plan.items.map((item, index) => (
            <li key={`${entry.id}-${index}`} className="sticky-plan-item">
              <span
                className={
                  item.done
                    ? "sticky-plan-marker sticky-plan-marker-done"
                    : "sticky-plan-marker"
                }
                aria-hidden="true"
              />
              <span
                className={
                  item.done
                    ? "sticky-plan-item-text sticky-plan-item-text-done"
                    : "sticky-plan-item-text"
                }
              >
                {item.text}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {plan.body ? <pre className="sticky-plan-body">{plan.body}</pre> : null}
    </section>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="task-detail-icon">
      <path
        d="M6 3.5h6.5v8H6zM3.5 6V12.5H10"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}
