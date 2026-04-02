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
import { cn } from "@/lib/utils";

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

const logKindBaseClass =
  "inline-flex min-h-5 items-center gap-2 whitespace-nowrap rounded-none border border-border bg-[var(--panel)] px-2 text-[0.64rem] uppercase tracking-[0.08em]";
const logStatusChipBaseClass =
  "inline-flex items-center rounded-none border px-1.5 py-[2px] font-mono text-[0.58rem] uppercase tracking-[0.08em]";
const logConsoleLabelBaseClass =
  "inline-flex min-h-[18px] items-center rounded-none border px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.08em]";

function getLogKindToneClass(kind: RunLogEntry["kind"]): string {
  switch (kind) {
    case "plan":
      return "text-[var(--success)]";
    case "tool_call":
    case "tool_output":
      return "text-[var(--warning)]";
    case "user":
      return "text-[var(--info)]";
    case "agent":
      return "text-[var(--accent-strong)]";
    default:
      return "text-[var(--muted)]";
  }
}

function getLogStatusToneClass(tone: string): string {
  switch (tone) {
    case "completed":
      return "text-[var(--success)]";
    case "failed":
    case "interrupted":
      return "text-[var(--danger)]";
    case "started":
      return "text-[var(--info)]";
    default:
      return "text-[var(--warning)]";
  }
}

function getConsoleToneClasses(
  tone: "agent" | "plan" | "status" | "stderr" | "system" | "tool" | "user" | "stdout"
) {
  switch (tone) {
    case "agent":
      return {
        entry: "border-l-[rgba(73,214,196,0.42)]",
        label: "text-[var(--accent)]"
      };
    case "plan":
      return {
        entry: "border-l-[rgba(99,216,158,0.44)]",
        label: "text-[var(--success)]"
      };
    case "status":
      return {
        entry: "border-l-[rgba(104,199,246,0.36)]",
        label: "text-[var(--info)]"
      };
    case "stderr":
      return {
        entry: "border-l-[rgba(240,113,113,0.46)]",
        label: "text-[var(--danger)]"
      };
    case "system":
      return {
        entry: "border-l-[rgba(140,161,160,0.34)]",
        label: "text-[var(--muted)]"
      };
    case "tool":
      return {
        entry: "border-l-[rgba(242,195,92,0.42)]",
        label: "text-[var(--warning)]"
      };
    case "user":
      return {
        entry: "border-l-[rgba(104,199,246,0.42)]",
        label: "text-[var(--info)]"
      };
    default:
      return {
        entry: "border-l-[rgba(104,199,246,0.34)]",
        label: "text-[var(--info)]"
      };
  }
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
        <dl className="m-0 flex flex-wrap gap-2 gap-x-3 px-3 pt-3">
          {entryMetadata.map(([key, value]) => (
            <div key={`${entry.id}-${key}`} className="inline-flex min-w-0 gap-1.5">
              <dt className="text-[var(--muted)]">{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <pre className="m-0 overflow-x-auto px-3 py-3 text-[0.72rem] leading-[1.65] whitespace-pre-wrap break-words">
        {entry.text}
      </pre>
    </>
  );
}

function renderEntryHeader(entry: RunLogEntry, collapsible = false) {
  const toolStatus = getToolStatus(entry);
  const HeaderTag = collapsible ? "summary" : "header";

  return (
    <HeaderTag
      className={cn(
        "flex flex-col gap-1.5 border-b border-border bg-[var(--surface-faint)] px-3 py-2",
        collapsible && "cursor-pointer list-none",
        "min-[721px]:flex-row min-[721px]:items-start min-[721px]:justify-between"
      )}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 min-[721px]:flex-1">
        <span className={cn(logKindBaseClass, getLogKindToneClass(entry.kind))}>
          {ENTRY_LABELS[entry.kind]}
        </span>
        {entry.title ? (
          <strong>{entry.kind === "tool_call" ? normalizeToolTitle(entry) : entry.title}</strong>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3 text-[0.64rem] text-[var(--muted)]">
        {toolStatus ? (
          <span className={cn(logStatusChipBaseClass, getLogStatusToneClass(toolStatus.tone))}>
            {toolStatus.label}
          </span>
        ) : null}
        {entry.stream !== "stdout" ? (
          <span className={cn(logKindBaseClass, "text-[var(--muted)]")}>{entry.stream}</span>
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
    <article
      key={entry.id}
      className={cn(
        "grid min-w-0 gap-2 border-l-2 px-0 pb-2 pl-3 pt-2",
        getConsoleToneClasses(tone).entry
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 text-[0.64rem] text-[var(--muted)]">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn(logConsoleLabelBaseClass, getConsoleToneClasses(tone).label)}>
            {getConsoleEntryLabel(entry)}
          </span>
          {title ? <strong>{title}</strong> : null}
          {toolStatus ? (
            <span className={cn(logStatusChipBaseClass, getLogStatusToneClass(toolStatus.tone))}>
              {toolStatus.label}
            </span>
          ) : null}
        </div>
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
      </div>
      <pre
        className={cn(
          "m-0 overflow-x-auto text-[0.74rem] leading-[1.7] whitespace-pre-wrap break-words",
          tone === "stderr" && "text-[var(--danger)]"
        )}
      >
        {entry.text}
      </pre>
    </article>
  );
}

function renderToolOutputEntry(entry: RunLogEntry) {
  const tone = getConsoleEntryTone(entry);

  return (
    <article
      key={entry.id}
      className={cn(
        "grid gap-2 border-l-2 pl-3",
        tone === "stderr"
          ? "border-l-[rgba(240,113,113,0.42)]"
          : "border-l-[rgba(242,195,92,0.3)]"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[0.64rem] text-[var(--muted)]">
        <span className={cn(logConsoleLabelBaseClass, getConsoleToneClasses(tone).label)}>
          {getConsoleEntryLabel(entry)}
        </span>
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
      </div>
      <pre
        className={cn(
          "m-0 overflow-x-auto text-[0.74rem] leading-[1.7] whitespace-pre-wrap break-words",
          tone === "stderr" && "text-[var(--danger)]"
        )}
      >
        {entry.text}
      </pre>
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
      <details
        key={entry.id}
        className="grid gap-2.5 border-l-2 border-l-[rgba(242,195,92,0.42)] px-0 pb-2.5 pl-3 pt-2.5"
      >
        <summary className="grid cursor-pointer list-none gap-2">
          <div className="flex flex-wrap items-start justify-between gap-2 text-[0.64rem] text-[var(--muted)]">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={cn(logConsoleLabelBaseClass, "text-[var(--warning)]")}>tool</span>
              <strong>{normalizeToolTitle(entry)}</strong>
              {toolStatus ? (
                <span className={cn(logStatusChipBaseClass, getLogStatusToneClass(toolStatus.tone))}>
                  {toolStatus.label}
                </span>
              ) : null}
            </div>
            <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
          </div>
          {preview ? (
            <code className="overflow-hidden text-ellipsis whitespace-nowrap text-[var(--muted)]">
              {preview}
            </code>
          ) : null}
        </summary>

        <div>{renderEntryBody(entry)}</div>

        {outputEntries.length > 0 ? (
          <details className="grid gap-2 border-l border-border pl-3">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-[0.68rem] text-[var(--muted)]">
              <span className={cn(logConsoleLabelBaseClass, "text-[var(--warning)]")}>
                tool output
              </span>
              <span>{outputEntries.length} block{outputEntries.length > 1 ? "s" : ""}</span>
            </summary>
            <div className="grid gap-2">
              {outputEntries.map((outputEntry) => renderToolOutputEntry(outputEntry))}
            </div>
          </details>
        ) : null}
      </details>
    );
  }

  return (
    <article
      key={entry.id}
      className="grid gap-2.5 border-l-2 border-l-[rgba(242,195,92,0.42)] px-0 pb-2.5 pl-3 pt-2.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 text-[0.64rem] text-[var(--muted)]">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn(logConsoleLabelBaseClass, "text-[var(--warning)]")}>tool</span>
          <strong>{normalizeToolTitle(entry)}</strong>
          {toolStatus ? (
            <span className={cn(logStatusChipBaseClass, getLogStatusToneClass(toolStatus.tone))}>
              {toolStatus.label}
            </span>
          ) : null}
        </div>
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
      </div>

      <div>{renderEntryBody(entry)}</div>

      {outputEntries.length > 0 ? (
        <details className="grid gap-2 border-l border-border pl-3">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-[0.68rem] text-[var(--muted)]">
            <span className={cn(logConsoleLabelBaseClass, "text-[var(--warning)]")}>
              tool output
            </span>
            <span>{outputEntries.length} block{outputEntries.length > 1 ? "s" : ""}</span>
          </summary>
          <div className="grid gap-2">
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
      className="grid gap-2.5 border-l-2 border-l-[rgba(242,195,92,0.5)] px-0 pb-2.5 pl-3 pt-2.5"
    >
      <summary className="grid cursor-pointer list-none gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2 text-[0.64rem] text-[var(--muted)]">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={cn(logConsoleLabelBaseClass, "text-[var(--warning)]")}>tool</span>
            <strong>{commandLabel}</strong>
          </div>
          <span className="text-[0.64rem] text-[var(--muted)]">
            {formatTimestampRange(firstEntry.timestamp, lastEntry.timestamp)}
          </span>
        </div>
      </summary>

      <div className="grid gap-0 border-l border-border pl-3">
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
    <div
      className={
        showStatus ? "grid min-h-0 gap-4 p-4 max-[720px]:p-3" : "flex h-full min-h-0 flex-1 flex-col"
      }
    >
      {showStatus ? (
        <section className="grid gap-3 rounded-none border border-border bg-[var(--panel)] p-4">
          <h3 className="m-0 text-[0.82rem]">Run status</h3>
          <div className="flex flex-col items-start justify-between gap-3 rounded-none border border-border bg-[var(--panel)] p-3 min-[721px]:flex-row min-[721px]:items-center">
            <div>
              <strong>{activeRun ? activeRun.status : "idle"}</strong>
              <p className="m-0 text-[var(--muted)]">{activeRun ? activeRun.id : "No active run"}</p>
            </div>
            <div className="text-[var(--muted)]">{task.runnerType}</div>
          </div>
          {viewedRun ? (
            <p className="m-0 text-[var(--muted)]">
              Viewing {viewedRun.status} run {viewedRun.id}
            </p>
          ) : null}
          {viewedRun?.status === "canceled" && !activeRun ? (
            <p className="m-0 text-[var(--muted)]">
              This run was canceled. That usually means it was stopped manually before completion.
            </p>
          ) : null}
          {viewedRun?.status === "interrupted" && !activeRun ? (
            <p className="m-0 text-[var(--muted)]">
              {task.runnerType === "codex"
                ? "This run was interrupted while Workhorse was offline. Starting the task again will resume the previous Codex session when possible."
                : "This run was interrupted while Workhorse was offline. Start the task again to continue the work."}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] rounded-none border border-border bg-[var(--panel)]">
        <div
          className={
            showStatus
              ? "flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3"
              : "flex flex-wrap items-center justify-between gap-2 border-b border-border bg-[var(--panel)] px-4 py-3 max-[720px]:flex-col max-[720px]:items-stretch max-[720px]:px-3"
          }
        >
          <div className={showStatus ? "grid gap-1" : "flex min-w-0 flex-wrap items-center gap-2"}>
            <h3 className="m-0">Live log</h3>
            {streamEntries.length > 0 ? (
              <span
                className="m-0 font-mono text-[0.58rem] uppercase tracking-[0.14em] text-[var(--muted)]"
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
              className="inline-flex min-h-6 items-center gap-1.5 rounded-none border border-transparent bg-transparent px-2 text-[0.75rem] text-[var(--muted)] transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-border hover:bg-[var(--surface-soft)]"
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
          <div className="border-b border-border bg-[var(--panel)] px-4 py-3 text-[0.74rem] text-[var(--muted)] max-[720px]:px-3">
            Viewing {viewedRun.status} run{" "}
            <code className="font-mono text-[0.72rem] text-[var(--accent)]">{viewedRun.id}</code>
          </div>
        ) : null}
        {aggregatedEntries.length === 0 ? (
          isLoading ? (
            <div className="grid h-[clamp(260px,58vh,680px)] place-items-center overflow-auto border-t-0 px-3 py-3 text-[var(--muted)]">
              Loading logs...
            </div>
          ) : (
            <div className="grid h-[clamp(260px,58vh,680px)] place-items-center overflow-auto border-t-0 px-3 py-3 text-[var(--muted)]">
              Logs will appear here when a run starts.
            </div>
          )
        ) : !hasVisibleEntries ? (
          <div className="grid h-[clamp(260px,58vh,680px)] place-items-center overflow-auto border-t-0 px-3 py-3 text-[var(--muted)]">
            Waiting for meaningful output.
          </div>
        ) : (
          <div className="grid min-h-0 gap-3">
            <div className="grid min-h-0 gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 max-[720px]:px-3">
                <p className="m-0 font-mono text-[0.64rem] uppercase tracking-[0.14em] text-[var(--muted)]">
                  Output stream
                </p>
                {streamEntries.length > 0 && !isPinnedToBottom ? (
                  <span className={cn(logKindBaseClass, "text-[var(--muted)]")}>
                    Scroll paused
                  </span>
                ) : null}
              </div>
              {streamEntries.length > 0 ? (
                <div
                  ref={streamRef}
                  className="mx-4 mb-4 grid h-[clamp(260px,58vh,680px)] min-h-0 auto-rows-max content-start gap-2 overflow-auto border border-border bg-[linear-gradient(180deg,var(--panel-strong),var(--bg))] p-3 max-[720px]:mx-3 max-[720px]:mb-3"
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
                <div className="mx-4 mb-4 grid h-[clamp(260px,58vh,680px)] min-h-0 auto-rows-max content-start gap-2 overflow-auto border border-border bg-[linear-gradient(180deg,var(--panel-strong),var(--bg))] p-3 max-[720px]:mx-3 max-[720px]:mb-3">
                  {stickyPlanEntry && stickyPlan ? (
                    <StickyPlanCard entry={stickyPlanEntry} plan={stickyPlan} />
                  ) : (
                    <div className="grid place-items-center text-[var(--muted)]">
                      This run did not emit output.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {canSendInput && onSendInput ? (
          <form
            className="grid gap-2 border-t border-border bg-[linear-gradient(180deg,var(--panel),var(--surface-faint))] px-4 py-3 max-[720px]:px-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSendInput();
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex min-w-0 flex-wrap items-baseline gap-2.5">
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
            <label className="block">
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
                className="min-h-14 resize-y"
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2.5 text-[0.68rem] leading-[1.4] text-[var(--muted)]">
              <span>Press Ctrl/Cmd+Enter to send.</span>
              {submitError ? <span className="text-[var(--danger)]">{submitError}</span> : null}
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
    <section className="sticky top-0 z-[3] grid gap-3 rounded-none border border-border bg-[linear-gradient(180deg,var(--panel),var(--panel-strong))] p-4 shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="inline-flex min-h-[22px] items-center rounded-none border border-[rgba(73,214,196,0.28)] bg-[rgba(73,214,196,0.1)] px-2 font-mono text-[0.62rem] uppercase tracking-[0.12em] text-[var(--accent-strong)]">
            Plan
          </span>
          <strong>{summary}</strong>
        </div>
        <time className="text-[0.68rem] text-[var(--muted)]" dateTime={entry.timestamp}>
          {formatTimestamp(entry.timestamp)}
        </time>
      </div>

      {plan.summary && plan.items.length > 0 ? (
        <p className="m-0 text-[var(--muted)]">{plan.summary}</p>
      ) : null}

      {plan.items.length > 0 ? (
        <ol className="m-0 grid list-none gap-2.5 p-0">
          {plan.items.map((item, index) => (
            <li key={`${entry.id}-${index}`} className="flex items-start gap-2.5">
              <span
                className={cn(
                  "relative top-[0.15rem] size-[14px] shrink-0 rounded-full border border-current text-[var(--muted)]",
                  item.done &&
                    "text-[var(--success)] after:absolute after:inset-[3px] after:rounded-full after:bg-current after:content-['']"
                )}
                aria-hidden="true"
              />
              <span
                className={cn(item.done && "text-[var(--muted)] line-through")}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {plan.body ? (
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words pt-0.5 text-[var(--muted)]">
          {plan.body}
        </pre>
      ) : null}
    </section>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3 shrink-0">
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
