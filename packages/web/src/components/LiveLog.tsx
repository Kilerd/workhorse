import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

type CommandIntent = "build" | "command" | "git" | "read" | "search" | "test";
type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; code: string }
  | { type: "heading"; depth: number; text: string };

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

function formatTimestampRange(start: string, end: string): string {
  const startLabel = formatTimestamp(start);
  const endLabel = formatTimestamp(end);
  if (!startLabel || !endLabel || startLabel === endLabel) {
    return endLabel || startLabel;
  }

  return `${startLabel} - ${endLabel}`;
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

function getCommandIntent(text: string): CommandIntent {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .find(Boolean);

  if (!firstLine) {
    return "command";
  }

  if (/^(rg|grep|fd|find)\b/.test(firstLine) || firstLine.includes(" search ")) {
    return "search";
  }

  if (
    /^(sed|cat|head|tail|less|more|awk|cut)\b/.test(firstLine) ||
    firstLine.startsWith("bat ") ||
    firstLine.startsWith("open ")
  ) {
    return "read";
  }

  if (
    firstLine.includes("npm run test") ||
    firstLine.includes("pnpm run test") ||
    firstLine.includes("yarn test") ||
    firstLine.includes("vitest") ||
    firstLine.includes("jest") ||
    firstLine.includes("pytest") ||
    firstLine.includes("cargo test")
  ) {
    return "test";
  }

  if (
    firstLine.includes("npm run build") ||
    firstLine.includes("pnpm run build") ||
    firstLine.includes("yarn build") ||
    firstLine.includes("vite build") ||
    firstLine.includes("tsc ") ||
    firstLine === "tsc" ||
    firstLine.includes("cargo build")
  ) {
    return "build";
  }

  if (/^git\s+(status|diff|show|log|branch|grep|rev-parse)\b/.test(firstLine)) {
    return "git";
  }

  return "command";
}

function getIntentLabel(intent: CommandIntent, count: number): string {
  switch (intent) {
    case "read":
      return count === 1 ? "Read a file" : `Read ${count} files`;
    case "search":
      return count === 1 ? "Searched code" : `Searched code ${count} times`;
    case "test":
      return count === 1 ? "Ran tests" : `Ran ${count} test commands`;
    case "build":
      return count === 1 ? "Built the project" : `Ran ${count} build commands`;
    case "git":
      return count === 1 ? "Checked git state" : `Checked git state ${count} times`;
    default:
      return count === 1 ? "Ran a command" : `Ran ${count} commands`;
  }
}

function getToolActivityLabel(entry: RunLogEntry, count = 1): string {
  const itemType = entry.metadata?.itemType?.toLowerCase() ?? "";

  if (itemType.includes("filesearch")) {
    return count === 1 ? "Searched code" : `Searched code ${count} times`;
  }

  if (itemType.includes("filechange")) {
    return count === 1 ? "Edited a file" : `Edited ${count} files`;
  }

  if (itemType.includes("command")) {
    return getIntentLabel(getCommandIntent(entry.text), count);
  }

  const title = normalizeToolTitle(entry);
  if (count === 1) {
    return title;
  }

  return `${count} ${title.toLowerCase()} actions`;
}

function getCommandGroupLabel(item: LiveLogCommandExecutionGroupStreamItem): string {
  const intents = item.items.map(({ entry }) => getCommandIntent(entry.text));
  const [firstIntent] = intents;
  const sameIntent = Boolean(firstIntent) && intents.every((intent) => intent === firstIntent);

  return getIntentLabel(sameIntent && firstIntent ? firstIntent : "command", item.items.length);
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

function isSafeMarkdownHref(value: string): boolean {
  return /^(https?:\/\/|mailto:|\/|\.\/|\.\.\/|#)/i.test(value);
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|((?:https?:\/\/|mailto:)[^\s<]+)/g;
  let lastIndex = 0;
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }

    const key = `${keyPrefix}-${index}`;
    const [, label, href, code, strong, bareUrl] = match;

    if (label && href) {
      const normalizedHref = href.trim();
      if (isSafeMarkdownHref(normalizedHref)) {
        parts.push(
          <a
            key={key}
            href={normalizedHref}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] no-underline hover:underline"
            title={normalizedHref}
          >
            {label}
          </a>
        );
      } else {
        parts.push(match[0]);
      }
    } else if (bareUrl) {
      parts.push(
        <a
          key={key}
          href={bareUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--accent)] no-underline hover:underline"
        >
          {bareUrl}
        </a>
      );
    } else if (code) {
      parts.push(
        <code
          key={key}
          className="border border-border bg-[var(--surface-soft)] px-1 font-mono text-[0.8em]"
        >
          {code}
        </code>
      );
    } else if (strong) {
      parts.push(
        <strong key={key} className="font-semibold text-[var(--text)]">
          {strong}
        </strong>
      );
    } else {
      parts.push(match[0]);
    }

    lastIndex = start + match[0].length;
    index += 1;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push({
        type: "code",
        code: codeLines.join("\n")
      });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        depth: headingMatch[1]?.length ?? 1,
        text: headingMatch[2] ?? ""
      });
      index += 1;
      continue;
    }

    const listMatch = line.match(/^\s*((?:[-*+])|(?:\d+\.))\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1] ?? "");
      const items: string[] = [];

      while (index < lines.length) {
        const currentLine = lines[index] ?? "";
        const currentMatch = currentLine.match(/^\s*((?:[-*+])|(?:\d+\.))\s+(.+)$/);
        if (!currentMatch || /\d+\./.test(currentMatch[1] ?? "") !== ordered) {
          break;
        }

        items.push(currentMatch[2] ?? "");
        index += 1;
      }

      blocks.push({
        type: "list",
        ordered,
        items
      });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const currentLine = lines[index] ?? "";
      const currentTrimmed = currentLine.trim();
      if (!currentTrimmed) {
        break;
      }
      if (
        currentTrimmed.startsWith("```") ||
        /^#{1,3}\s+/.test(currentTrimmed) ||
        /^\s*((?:[-*+])|(?:\d+\.))\s+/.test(currentLine)
      ) {
        break;
      }

      paragraphLines.push(currentLine);
      index += 1;
    }

    blocks.push({
      type: "paragraph",
      text: paragraphLines.join("\n")
    });
  }

  return blocks;
}

function renderMarkdownBlock(
  text: string,
  options: {
    className?: string;
    tone?: "default" | "danger" | "muted";
  } = {}
) {
  const { className, tone = "default" } = options;
  const blocks = parseMarkdownBlocks(text);

  return (
    <div
      className={cn(
        "grid gap-3 text-[0.9rem] leading-[1.76]",
        tone === "danger"
          ? "text-[var(--danger)]"
          : tone === "muted"
            ? "text-[var(--muted)]"
            : "text-[var(--text)]",
        className
      )}
    >
      {blocks.map((block, index) => {
        const key = `markdown-${index}`;

        if (block.type === "code") {
          return (
            <pre
              key={key}
              className="m-0 overflow-x-auto border border-border bg-[var(--surface-soft)] px-3 py-2 font-mono text-[0.72rem] leading-[1.72]"
            >
              {block.code}
            </pre>
          );
        }

        if (block.type === "heading") {
          const HeadingTag = block.depth === 1 ? "h3" : block.depth === 2 ? "h4" : "h5";

          return (
            <HeadingTag key={key} className="m-0 text-[0.84rem] font-semibold">
              {renderInlineMarkdown(block.text, key)}
            </HeadingTag>
          );
        }

        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";

          return (
            <ListTag
              key={key}
              className={cn(
                "m-0 grid gap-1 pl-5",
                block.ordered ? "list-decimal" : "list-disc"
              )}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-item-${itemIndex}`}>
                  {renderInlineMarkdown(item, `${key}-item-${itemIndex}`)}
                </li>
              ))}
            </ListTag>
          );
        }

        return (
          <p key={key} className="m-0 whitespace-pre-wrap break-words">
            {renderInlineMarkdown(block.text, key).map((node, nodeIndex) => (
              <Fragment key={`${key}-node-${nodeIndex}`}>{node}</Fragment>
            ))}
          </p>
        );
      })}
    </div>
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
        <div className="border border-[rgba(104,199,246,0.24)] bg-[var(--panel)] px-4 py-3">
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
            "border px-4 py-3",
            isError
              ? "border-[rgba(240,113,113,0.22)] bg-[rgba(240,113,113,0.06)]"
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
        "grid gap-2 border px-4 py-3",
        isError
          ? "border-[rgba(240,113,113,0.18)] bg-[rgba(240,113,113,0.06)]"
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
        <section className="grid gap-3 rounded-none border border-border bg-[var(--panel)] p-4 text-[0.78rem]">
          <h3 className="m-0 text-[0.76rem]">Run status</h3>
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

      <section className={cn(
        "grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] rounded-none border border-border bg-[var(--panel)]",
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
                className="inline-flex min-h-5 items-center rounded-none border border-border bg-[var(--panel)] px-2 font-mono text-[0.54rem] uppercase tracking-[0.14em] text-[var(--muted)]"
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
                className="inline-flex min-h-7 items-center gap-1.5 rounded-none border border-transparent bg-transparent px-2.5 text-[0.7rem] text-[var(--muted)] transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-border hover:bg-[var(--surface-soft)]"
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
                  {inputMode === "review" ? "Continue thread" : "Intervene live"}
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
                  inputMode === "review"
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
    <section className="sticky top-0 z-[3] grid gap-3 rounded-none border border-border bg-[linear-gradient(180deg,var(--panel),var(--panel-strong))] p-4 shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
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
