import { useEffect, useMemo, useRef, useState } from "react";
import type { Run, RunLogEntry, Task } from "@workhorse/contracts";
import type { LiveLogCommandExecutionGroupStreamItem } from "./live-log-entries";

import {
  buildLiveLogStreamItems,
  ENTRY_LABELS,
  getToolStatus,
  groupLiveLogStreamItems,
  parseStickyPlanContent,
  partitionLiveLogEntries,
  metadataEntries,
  normalizeToolTitle,
  prepareLiveLogEntries
} from "./live-log-entries";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatTimestamp, formatTimestampRange } from "@/lib/format";
import { renderMarkdownBlock } from "@/lib/markdown";
import { getToolActivityLabel, getCommandGroupLabel } from "@/lib/command-intent";
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
  inputMode?: "running" | "review" | "plan-feedback" | null;
  onSendInput?(text: string): Promise<unknown>;
}

const logStatusChipBaseClass =
  "inline-flex min-h-5 items-center px-1 py-[2px] font-mono text-[0.54rem] uppercase tracking-[0.1em]";
const logEyebrowBaseClass =
  "inline-flex min-h-5 items-center gap-1.5 whitespace-nowrap px-1 font-mono text-[0.54rem] uppercase tracking-[0.1em]";

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


function getEntryTitle(entry: RunLogEntry): string | null {
  if (entry.kind === "tool_call") {
    return normalizeToolTitle(entry);
  }

  if (entry.title && !["Agent output", "Tool output"].includes(entry.title)) {
    return entry.title;
  }

  return null;
}

function buildCopyPayload(entries: RunLogEntry[]): string {
  return entries
    .map((entry) => {
      const title = getEntryTitle(entry);
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

function summarizeToolPreview(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}


function renderEntryMetadata(entry: RunLogEntry) {
  const entryMetadata = metadataEntries(entry);
  if (entryMetadata.length === 0) {
    return null;
  }

  return (
    <dl className="m-0 flex flex-wrap gap-2 px-4 pt-4 text-[0.64rem] text-[var(--muted)]">
      {entryMetadata.map(([key, value]) => (
        <div
          key={`${entry.id}-${key}`}
          className="inline-flex min-w-0 items-center gap-1 border border-border bg-[var(--surface-soft)] px-2 py-1"
        >
          <dt className="font-mono uppercase tracking-[0.12em] text-[0.5rem] text-[var(--muted)]">
            {key}
          </dt>
          <dd className="m-0 min-w-0 truncate text-[var(--text)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function renderProseBlock(
  text: string,
  options: {
    className?: string;
    tone?: "default" | "danger" | "muted";
  } = {}
) {
  const { className, tone = "default" } = options;

  return (
    <pre
      className={cn(
        "m-0 whitespace-pre-wrap break-words font-sans text-[0.9rem] leading-[1.76] tracking-[0.005em]",
        tone === "danger"
          ? "text-[var(--danger)]"
          : tone === "muted"
            ? "text-[var(--muted)]"
            : "text-[var(--text)]",
        className
      )}
    >
      {text}
    </pre>
  );
}

function renderMonospaceBlock(
  text: string,
  options: {
    className?: string;
    tone?: "default" | "danger" | "muted";
  } = {}
) {
  const { className, tone = "default" } = options;

  return (
    <pre
      className={cn(
        "m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[0.72rem] leading-[1.72]",
        tone === "danger"
          ? "text-[var(--danger)]"
          : tone === "muted"
            ? "text-[var(--muted)]"
            : "text-[var(--text)]",
        className
      )}
    >
      {text}
    </pre>
  );
}

function renderStreamEntry(entry: RunLogEntry) {
  const toolStatus = getToolStatus(entry);
  const title = getEntryTitle(entry);

  if (entry.kind === "user") {
    return (
      <article key={entry.id} className="ml-auto grid max-w-[min(34rem,86%)] gap-1 justify-items-end">
        <div className="rounded-[var(--radius)] border border-[rgba(255,79,0,0.24)] bg-[var(--panel)] px-4 py-3">
          {renderProseBlock(entry.text, {
            className: "text-[0.86rem] leading-[1.68]"
          })}
        </div>
        <div className="pr-1 text-[0.64rem] text-[var(--muted)]">
          <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
        </div>
      </article>
    );
  }

  if (entry.kind === "agent") {
    return (
      <article key={entry.id} className="grid max-w-[min(48rem,94%)] gap-1">
        <div className="flex flex-wrap items-center gap-2 pl-1 text-[0.64rem] text-[var(--muted)]">
          <span
            className={cn(
              logEyebrowBaseClass,
              "text-[var(--accent-strong)]"
            )}
          >
            assistant
          </span>
          {title ? <span>{title}</span> : null}
          <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
        </div>
        <div className="border border-border bg-[var(--panel)] px-4 py-3">
          {renderMarkdownBlock(entry.text)}
        </div>
      </article>
    );
  }

  if (entry.kind === "text") {
    const isError = entry.stream === "stderr";

    return (
      <article key={entry.id} className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2 pl-1 text-[0.64rem] text-[var(--muted)]">
          <span
            className={cn(
              logEyebrowBaseClass,
              isError
                ? "text-[var(--danger)]"
                : "text-[var(--muted)]"
            )}
          >
            {entry.stream}
          </span>
          {title ? <span>{title}</span> : null}
          <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
        </div>
        <div
          className={cn(
            "rounded-[var(--radius)] border px-4 py-3",
            isError
              ? "border-[rgba(181,74,74,0.22)] bg-[rgba(181,74,74,0.06)]"
              : "border-border bg-[var(--surface-soft)]"
          )}
        >
          {renderMonospaceBlock(entry.text, {
            tone: isError ? "danger" : "default"
          })}
        </div>
      </article>
    );
  }

  const preview = summarizeToolPreview(entry.text);

  return (
    <article key={entry.id} className="flex py-1">
      <div className="flex flex-wrap items-center gap-2 pl-1 text-left text-[0.68rem]">
        <span
          className={cn(
            logEyebrowBaseClass,
            entry.kind === "status"
              ? "text-[var(--info)]"
              : "text-[var(--muted)]"
          )}
        >
          {ENTRY_LABELS[entry.kind]}
        </span>
        {title ? <strong className="text-[var(--text)]">{title}</strong> : null}
        {preview ? <span className="text-[var(--muted)]">{preview}</span> : null}
        {toolStatus ? (
          <span className={cn(logStatusChipBaseClass, getLogStatusToneClass(toolStatus.tone))}>
            {toolStatus.label}
          </span>
        ) : null}
        <time className="text-[var(--muted)]" dateTime={entry.timestamp}>
          {formatTimestamp(entry.timestamp)}
        </time>
      </div>
    </article>
  );
}

function renderToolOutputEntry(entry: RunLogEntry) {
  const isError = entry.stream === "stderr";

  return (
    <article
      key={entry.id}
      className={cn(
        "grid gap-2 rounded-[var(--radius)] border px-4 py-3",
        isError
          ? "border-[rgba(181,74,74,0.18)] bg-[rgba(181,74,74,0.06)]"
          : "border-border bg-[var(--surface-soft)]"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[0.64rem] text-[var(--muted)]">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={cn(
              logEyebrowBaseClass,
              isError
                ? "text-[var(--danger)]"
                : "text-[var(--warning)]"
            )}
          >
            {entry.stream === "stderr" ? "tool stderr" : "tool output"}
          </span>
        </div>
        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
      </div>
      {renderMonospaceBlock(entry.text, {
        tone: isError ? "danger" : "default"
      })}
    </article>
  );
}

function renderToolStreamItem(entry: RunLogEntry, outputEntries: RunLogEntry[]) {
  const toolStatus = getToolStatus(entry);
  const preview = summarizeToolPreview(entry.text);

  return (
    <details
      key={entry.id}
      className="px-0 py-0.5"
    >
      <summary className="list-none cursor-pointer px-1 py-1">
        <div className="grid min-w-0 gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[0.76rem]">
            <span className="pt-[1px] text-[var(--muted)]" aria-hidden="true">
              <DisclosureIcon />
            </span>
            <span
              className={cn(
                logEyebrowBaseClass,
                "text-[var(--warning)]"
              )}
            >
              activity
            </span>
            <strong className="text-[0.86rem] font-medium text-[var(--text)]">
              {getToolActivityLabel(entry)}
            </strong>
            {toolStatus ? (
              <span className={cn(logStatusChipBaseClass, getLogStatusToneClass(toolStatus.tone))}>
                {toolStatus.label}
              </span>
            ) : null}
            <time className="text-[0.72rem] text-[var(--muted)]" dateTime={entry.timestamp}>
              {formatTimestamp(entry.timestamp)}
            </time>
          </div>
          {preview ? (
            <code className="overflow-hidden text-ellipsis whitespace-nowrap pl-6 font-mono text-[0.68rem] text-[var(--muted)]">
              {preview}
            </code>
          ) : null}
        </div>
      </summary>

      <div className="mt-1 grid gap-2 pl-6 max-[640px]:pl-0">
        <div className="border border-border bg-[var(--surface-soft)]">
          {renderEntryMetadata(entry)}
          <div className="px-4 py-2.5">
            {renderMonospaceBlock(entry.text)}
          </div>
        </div>

        {outputEntries.length > 0 ? (
          <details className="border border-border bg-[var(--surface-faint)] px-4 py-2">
            <summary className="list-none cursor-pointer">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[0.68rem] text-[var(--muted)]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[var(--muted)]" aria-hidden="true">
                    <DisclosureIcon />
                  </span>
                  <span
                    className={cn(
                      logEyebrowBaseClass,
                      "text-[var(--warning)]"
                    )}
                  >
                    output
                  </span>
                  <span>
                    {outputEntries.length} block{outputEntries.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            </summary>
            <div className="mt-2 grid gap-1.5">
              {outputEntries.map((outputEntry) => renderToolOutputEntry(outputEntry))}
            </div>
          </details>
        ) : null}
      </div>
    </details>
  );
}

function renderCommandExecutionGroup(item: LiveLogCommandExecutionGroupStreamItem) {
  const firstEntry = item.items[0]?.entry;
  const lastEntry = item.items.at(-1)?.entry;
  if (!firstEntry || !lastEntry) {
    return null;
  }

  return (
    <details
      key={`${firstEntry.id}-${lastEntry.id}`}
      className="px-0 py-0.5"
    >
      <summary className="list-none cursor-pointer px-1 py-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={cn(
              logEyebrowBaseClass,
              "text-[var(--warning)]"
            )}
          >
            activity
          </span>
          <strong className="text-[0.86rem] font-medium text-[var(--text)]">
            {getCommandGroupLabel(item)}
          </strong>
          <span className="text-[0.72rem] text-[var(--muted)]">
            {formatTimestampRange(firstEntry.timestamp, lastEntry.timestamp)}
          </span>
        </div>
      </summary>

      <div className="mt-1 grid gap-1 pl-6 max-[640px]:pl-0">
        {item.items.map(({ entry, outputEntries }) => renderToolStreamItem(entry, outputEntries))}
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
        : inputMode === "plan-feedback"
          ? "Provide feedback to refine the plan. Claude will resume the planning session."
          : null;
  const viewportClassName = showStatus
    ? "mx-4 mb-4 grid h-[clamp(260px,58vh,680px)] min-h-0 auto-rows-max content-start gap-2.5 overflow-auto border border-border bg-[var(--surface-faint)] p-4 max-[720px]:mx-3 max-[720px]:mb-3 max-[720px]:gap-2 max-[720px]:p-3"
    : "mx-4 mb-4 grid min-h-0 auto-rows-max content-start gap-2.5 overflow-auto border border-border bg-[var(--surface-faint)] p-4 max-[720px]:mx-3 max-[720px]:mb-3 max-[720px]:gap-2 max-[720px]:p-3";

  return (
    <div
      className={
        showStatus ? "grid min-h-0 gap-4 p-4 max-[720px]:p-3" : "flex h-full min-h-0 flex-1 flex-col"
      }
    >
      {showStatus ? (
        <section className="grid gap-3 rounded-[var(--radius-lg)] border border-border bg-[var(--panel)] p-4 text-[0.78rem]">
          <h3 className="m-0 text-[0.76rem]">Run status</h3>
          <div className="flex flex-col items-start justify-between gap-3 rounded-[var(--radius)] border border-border bg-[var(--panel)] p-3 min-[721px]:flex-row min-[721px]:items-center">
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

      <section className={cn(
        "grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] rounded-[var(--radius-lg)] border border-border bg-[var(--panel)]",
        !showStatus && "flex-1"
      )}>
        <div
          className={
            showStatus
              ? "flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"
              : "flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 max-[720px]:px-3"
          }
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <h3 className="m-0 text-[0.9rem]">Live log</h3>
            {streamEntries.length > 0 ? (
              <span
                className="inline-flex min-h-7 items-center rounded-full border border-border bg-[var(--panel)] px-2.5 font-mono text-[0.58rem] uppercase tracking-[0.1em] text-[var(--muted)]"
                aria-label={`${streamEntries.length} stream entries`}
                title={`${streamEntries.length} stream entries`}
              >
                {streamEntries.length}
              </span>
            ) : null}
            {!showStatus && viewedRun ? (
              <span className="min-w-0 text-[0.68rem] text-[var(--muted)]">
                Viewing {viewedRun.status} run{" "}
                <code className="font-mono text-[0.68rem] text-[var(--accent)]">
                  {viewedRun.id}
                </code>
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {streamEntries.length > 0 && !isPinnedToBottom ? (
              <span className="font-mono text-[0.54rem] uppercase tracking-[0.14em] text-[var(--muted)]">
                Scroll paused
              </span>
            ) : null}
            {streamEntries.length > 0 ? (
              <button
                type="button"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-transparent bg-transparent px-3 text-[0.76rem] font-medium text-[var(--muted)] transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-border hover:bg-[var(--surface-soft)]"
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
        </div>

        {aggregatedEntries.length === 0 ? (
          isLoading ? (
            <div className="grid h-[clamp(260px,58vh,680px)] place-items-center overflow-auto px-3 py-3 text-[var(--muted)]">
              Loading logs...
            </div>
          ) : (
            <div className="grid h-[clamp(260px,58vh,680px)] place-items-center overflow-auto px-3 py-3 text-[var(--muted)]">
              Logs will appear here when a run starts.
            </div>
          )
        ) : !hasVisibleEntries ? (
          <div className="grid h-[clamp(260px,58vh,680px)] place-items-center overflow-auto px-3 py-3 text-[var(--muted)]">
            Waiting for meaningful output.
          </div>
        ) : (
          <div className="grid min-h-0">
            {streamEntries.length > 0 ? (
              <div ref={streamRef} className={viewportClassName} onScroll={handleStreamScroll}>
                {stickyPlanEntry && stickyPlan ? (
                  <StickyPlanCard entry={stickyPlanEntry} plan={stickyPlan} />
                ) : null}
                {displayItems.map((item) => {
                  if (item.type === "command_execution_group") {
                    return renderCommandExecutionGroup(item);
                  }

                  return item.type === "tool"
                    ? renderToolStreamItem(item.entry, item.outputEntries)
                    : renderStreamEntry(item.entry);
                })}
              </div>
            ) : (
              <div className={viewportClassName}>
                {stickyPlanEntry && stickyPlan ? (
                  <StickyPlanCard entry={stickyPlanEntry} plan={stickyPlan} />
                ) : (
                  <div className="grid h-full place-items-center text-[var(--muted)]">
                    This run did not emit output.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {canSendInput && onSendInput ? (
          <form
            className="grid gap-3 border-t border-border bg-[var(--panel)] px-4 py-4 max-[720px]:px-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSendInput();
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid gap-1">
                <strong className="text-[0.84rem]">
                  {inputMode === "plan-feedback"
                    ? "Refine plan"
                    : inputMode === "review"
                      ? "Continue thread"
                      : "Intervene live"}
                </strong>
                {inputAssistText ? (
                  <p className="m-0 text-[0.68rem] text-[var(--muted)]">{inputAssistText}</p>
                ) : null}
              </div>
              <Button
                type="submit"
                disabled={submitState === "sending" || draft.trim().length === 0}
                className="px-4"
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
                  inputMode === "plan-feedback"
                    ? "Describe how the plan should be adjusted..."
                    : inputMode === "review"
                      ? "Describe what should change next..."
                      : "Tell the agent what to do next..."
                }
                disabled={submitState === "sending"}
                className="min-h-16 resize-y"
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2.5 text-[0.64rem] leading-[1.4] text-[var(--muted)]">
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
      ? `${completedCount} of ${plan.items.length} task${plan.items.length === 1 ? "" : "s"} done`
      : plan.summary ?? "Execution plan";

  return (
    <section className="sticky top-0 z-[3] grid gap-3 rounded-[var(--radius-lg)] border border-border bg-[linear-gradient(180deg,var(--panel),var(--panel-strong))] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="inline-flex min-h-[22px] items-center px-1 font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent-strong)]">
            Plan
          </span>
          <strong>{summary}</strong>
        </div>
        <time className="text-[0.64rem] text-[var(--muted)]" dateTime={entry.timestamp}>
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
              <span className={cn(item.done && "text-[var(--muted)] line-through")}>
                {item.text}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {plan.body ? (
        <div className="border border-border bg-[var(--surface-soft)] px-4 py-3">
          {renderProseBlock(plan.body, {
            tone: "muted",
            className: "text-[0.8rem] leading-[1.62]"
          })}
        </div>
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

function DisclosureIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="size-2.5 shrink-0">
      <path
        d="M4 2.5 7.5 6 4 9.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}
