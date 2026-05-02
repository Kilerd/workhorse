import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { Message, Thread } from "@workhorse/contracts";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Folder,
  GitBranch,
  Loader2,
  XCircle
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { useWorkspaceAgents } from "@/hooks/useAgents";
import { usePlan } from "@/hooks/usePlans";
import {
  useThreadMessages,
  usePostThreadMessage
} from "@/hooks/useThreads";
import { getCommandIntent, type CommandIntent } from "@/lib/command-intent";
import { readErrorMessage } from "@/lib/error-message";
import { formatRelativeTime } from "@/lib/format";
import { renderMarkdownBlock } from "@/lib/markdown";
import { isScrolledNearBottom } from "@/lib/scroll-position";
import {
  clearThreadDraft,
  loadThreadDraft,
  persistThreadDraft
} from "@/lib/thread-drafts";
import {
  buildThreadDisplayItems,
  mergeAdjacentAgentChatMessages,
  type ThreadDisplayItem
} from "@/lib/thread-messages";
import { cn } from "@/lib/utils";

import { PlanDraftCard } from "./PlanDraftCard";

interface Props {
  threadId: string;
  /** Optional; when provided enables the coordinator-state hint. */
  thread?: Thread | null;
  sessionWorktree?: string | null;
  sessionBranch?: string | null;
  className?: string;
  /** Optional message filter applied before merging/clustering. */
  messageFilter?: (message: Message) => boolean;
  /** Optional placeholder shown when the (filtered) message list is empty. */
  emptyState?: ReactNode;
  /** Optional override for the composer placeholder. */
  composerPlaceholder?: string;
}

const MAX_CHAT_LENGTH = 10_240;
const AgentNamesContext = createContext<Map<string, string>>(new Map());

export function ThreadView({
  threadId,
  thread,
  sessionWorktree,
  sessionBranch,
  className,
  messageFilter,
  emptyState,
  composerPlaceholder: composerPlaceholderOverride
}: Props) {
  const messagesQuery = useThreadMessages(threadId);
  const postMessage = usePostThreadMessage(threadId);
  const workspaceAgentsQuery = useWorkspaceAgents(thread?.workspaceId ?? null);

  const messageListRef = useRef<HTMLDivElement>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [draft, setDraft] = useState("");
  const [hydratedDraftThreadId, setHydratedDraftThreadId] = useState<string | null>(null);

  const ordered = useMemo(() => {
    const items = messagesQuery.data ?? [];
    const sorted = [...items].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    );
    return messageFilter ? sorted.filter(messageFilter) : sorted;
  }, [messagesQuery.data, messageFilter]);
  const displayMessages = useMemo(
    () => mergeAdjacentAgentChatMessages(ordered),
    [ordered]
  );
  const displayItems = useMemo(
    () => buildThreadDisplayItems(displayMessages),
    [displayMessages]
  );
  const messageTailKey = useMemo(() => {
    const lastMessage = ordered.at(-1);
    if (!lastMessage) return "empty";
    return `${ordered.length}:${lastMessage.id}:${lastMessage.createdAt}:${readText(lastMessage.payload).length}`;
  }, [ordered]);

  const pendingCount = useMemo(
    () => ordered.filter((m) => isUserFacing(m) && !m.consumedByRunId).length,
    [ordered]
  );
  const agentNames = useMemo(
    () =>
      new Map(
        (workspaceAgentsQuery.data ?? []).map((agent) => [agent.id, agent.name] as const)
      ),
    [workspaceAgentsQuery.data]
  );
  const composerPlaceholder =
    composerPlaceholderOverride ??
    (thread?.kind === "task"
      ? "Message this task thread… use @coordinator, @worker, or @agentName to notify an agent."
      : "Message this thread…");

  useEffect(() => {
    setIsPinnedToBottom(true);
  }, [threadId]);

  useEffect(() => {
    setDraft(loadThreadDraft(threadId));
    setHydratedDraftThreadId(threadId);
  }, [threadId]);

  useEffect(() => {
    if (hydratedDraftThreadId !== threadId) {
      return;
    }

    persistThreadDraft(threadId, draft);
  }, [draft, hydratedDraftThreadId, threadId]);

  useEffect(() => {
    const node = messageListRef.current;
    if (!node || !isPinnedToBottom) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [isPinnedToBottom, messageTailKey]);

  function handleMessageListScroll() {
    const node = messageListRef.current;
    if (!node) {
      return;
    }

    setIsPinnedToBottom(isScrolledNearBottom(node));
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content) return;
    try {
      await postMessage.mutateAsync({ content, kind: "chat" });
      clearThreadDraft(threadId);
      setDraft("");
    } catch (error) {
      toast({
        title: "Couldn't send message",
        description: readErrorMessage(error, "Unable to send message."),
        variant: "destructive"
      });
    }
  }

  return (
    <AgentNamesContext.Provider value={agentNames}>
      <section className={cn("flex min-h-0 flex-col gap-3", className)}>
        {thread ? <CoordinatorHint thread={thread} pending={pendingCount} /> : null}

        {messagesQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading thread…</div>
        ) : messagesQuery.isError ? (
          <div className="text-sm text-destructive">
            {readErrorMessage(messagesQuery.error, "Failed to load messages.")}
          </div>
        ) : ordered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {emptyState ?? "No messages yet. Start the conversation below."}
          </div>
        ) : (
          <div
            ref={messageListRef}
            onScroll={handleMessageListScroll}
            className="grid min-h-0 flex-1 auto-rows-max content-start gap-2 overflow-y-auto pr-1"
          >
            {displayItems.map((item) => (
              <DisplayItemRow key={item.id} item={item} threadId={threadId} />
            ))}
          </div>
        )}

        <form
          className="shrink-0 grid gap-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
        >
          <Textarea
            rows={3}
            value={draft}
            maxLength={MAX_CHAT_LENGTH}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={composerPlaceholder}
            disabled={postMessage.isPending}
            className="min-h-20 resize-y"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <div className="min-w-0 flex flex-wrap items-center gap-2">
              {sessionWorktree ? (
                <SessionMeta kind="worktree" value={sessionWorktree} />
              ) : null}
              {sessionBranch ? <SessionMeta kind="branch" value={sessionBranch} /> : null}
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span>{draft.length}/{MAX_CHAT_LENGTH}</span>
              <Button
                type="submit"
                size="sm"
                disabled={postMessage.isPending || draft.trim().length === 0}
              >
                {postMessage.isPending ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        </form>
      </section>
    </AgentNamesContext.Provider>
  );
}

function CoordinatorHint({
  thread,
  pending
}: {
  thread: Thread;
  pending: number;
}) {
  if (thread.coordinatorState === "idle" && pending === 0) return null;

  const label =
    thread.coordinatorState === "running"
      ? pending > 0
        ? `Coordinator is thinking… ${pending} message${pending === 1 ? "" : "s"} queued for next turn`
        : "Coordinator is thinking…"
      : thread.coordinatorState === "queued"
        ? `Queued · ${pending} message${pending === 1 ? "" : "s"} pending`
        : null;

  if (!label) return null;

  return (
    <div className="rounded-md border border-border bg-[var(--panel)] px-3 py-1.5 text-xs text-muted-foreground">
      {label}
    </div>
  );
}

function SessionMeta({
  kind,
  value
}: {
  kind: "worktree" | "branch";
  value: string;
}) {
  const label = kind === "worktree" ? "Session worktree" : "Git branch";
  const Icon = kind === "worktree" ? Folder : GitBranch;

  return (
    <div
      className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-border bg-[var(--panel)] px-2 py-1.5 text-xs"
      title={label}
    >
      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <code className="max-w-[min(34rem,60vw)] truncate font-mono text-[0.72rem] text-foreground">
        {value}
      </code>
      <span className="sr-only">{label}</span>
    </div>
  );
}

function DisplayItemRow({
  item,
  threadId
}: {
  item: ThreadDisplayItem;
  threadId: string;
}) {
  if (item.type === "tool") {
    return <ToolEventGroup messages={item.messages} />;
  }
  if (item.type === "tool_cluster") {
    return <ToolEventCluster tools={item.tools} />;
  }

  return <MessageRow message={item.message} threadId={threadId} />;
}

function MessageRow({ message, threadId }: { message: Message; threadId: string }) {
  switch (message.kind) {
    case "chat":
      return <ChatRow message={message} />;
    case "tool_call":
    case "tool_output":
      return <ToolEventRow message={message} />;
    case "status":
      if (isStatusDivider(message)) {
        return <SystemEventRow message={message} />;
      }
      if (isRequestUserInputPayload(message.payload)) {
        return <RequestUserInputRow message={message} threadId={threadId} />;
      }
      return <StatusRow message={message} />;
    case "artifact":
      return <ArtifactRow message={message} />;
    case "plan_draft":
      return <PlanDraftRow message={message} threadId={threadId} />;
    case "plan_decision":
      return <PlanDecisionRow message={message} />;
    case "system_event":
      return <SystemEventRow message={message} />;
    default:
      return null;
  }
}

function senderLabel(message: Message, agentNames: Map<string, string>): string {
  if (message.sender.type === "user") return "you";
  if (message.sender.type === "system") return "system";
  return agentNames.get(message.sender.agentId) ?? "agent";
}

function senderTone(message: Message): string {
  switch (message.sender.type) {
    case "user":
      return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-100";
    case "agent":
      return "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-400/40 dark:bg-indigo-400/10 dark:text-indigo-100";
    default:
      return "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-400/40 dark:bg-slate-400/10 dark:text-slate-100";
  }
}

function Meta({ message, align }: { message: Message; align?: "end" }) {
  const agentNames = useContext(AgentNamesContext);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-[0.68rem] text-muted-foreground",
        align === "end" && "justify-end"
      )}
    >
      <span
        className={cn(
          "rounded border px-1.5 py-0.5 font-mono uppercase tracking-wide",
          senderTone(message)
        )}
      >
        {senderLabel(message, agentNames)}
      </span>
      <span className="rounded border border-border px-1.5 py-0.5 font-mono uppercase tracking-wide">
        {message.kind}
      </span>
      <span>{formatRelativeTime(message.createdAt)}</span>
    </div>
  );
}

function readText(payload: unknown): string {
  if (payload && typeof payload === "object" && "text" in payload) {
    const t = (payload as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  if (typeof payload === "string") return payload;
  return "";
}

function readObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function readStringField(
  payload: Record<string, unknown>,
  key: string
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArrayField(
  payload: Record<string, unknown>,
  key: string
): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

interface RequestUserInputPayload {
  kind: "request_user_input";
  question: string;
  options: string[];
}

function isRequestUserInputPayload(payload: unknown): payload is RequestUserInputPayload {
  const object = readObject(payload);
  return (
    readStringField(object, "kind") === "request_user_input" &&
    Boolean(readStringField(object, "question"))
  );
}

function humanizeToolName(value: string): string {
  const cleaned = value
    .replace(/\s+(started|completed)$/i, "")
    .replace(/^mcp__[^_]+__/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_/.-]+/g, " ")
    .trim();
  if (cleaned.toLowerCase() === "command execution") {
    return "Command";
  }
  return cleaned ? cleaned.replace(/\b\w/g, (char) => char.toUpperCase()) : "Tool";
}

function humanizeStatus(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_/.-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function summarizeValue(value: unknown): string {
  const text = stringifyValue(value).replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function toolStatusTone(status: string, isFailure: boolean): string {
  const normalized = status.toLowerCase();
  if (isFailure || normalized.includes("fail") || normalized.includes("error")) {
    return "border-[rgba(239,98,108,0.28)] bg-[rgba(239,98,108,0.08)] text-[var(--danger)]";
  }
  if (normalized.includes("complete") || normalized.includes("success")) {
    return "border-[rgba(39,166,68,0.24)] bg-[rgba(39,166,68,0.08)] text-[var(--success)]";
  }
  return "border-[rgba(214,164,73,0.24)] bg-[rgba(214,164,73,0.08)] text-[var(--warning)]";
}

function isCompletedToolStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized.includes("complete") || normalized.includes("success");
}

function ToolStatusIcon({
  status,
  isFailure
}: {
  status: string;
  isFailure: boolean;
}) {
  const normalized = status.toLowerCase();
  if (isFailure || normalized.includes("fail") || normalized.includes("error")) {
    return <XCircle className="size-3" aria-hidden="true" />;
  }
  if (isCompletedToolStatus(status)) {
    return <CheckCircle2 className="size-3" aria-hidden="true" />;
  }
  return <Loader2 className="size-3 animate-spin" aria-hidden="true" />;
}

export function ChatRow({ message }: { message: Message }) {
  const text = readText(message.payload);
  const isUser = message.sender.type === "user";
  const agentNames = useContext(AgentNamesContext);

  if (!isUser) {
    const label = message.sender.type === "agent" ? senderLabel(message, agentNames) : undefined;
    return (
      <article className="w-full max-w-[min(54rem,96%)] px-1 py-1 text-sm leading-[1.55]">
        {label ? (
          <div className="mb-1 text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
        ) : null}
        {renderMarkdownBlock(text, { className: "gap-2" })}
      </article>
    );
  }

  return (
    <article className="ml-auto grid max-w-[min(34rem,92%)] justify-items-end">
      <div
        className={cn(
          "rounded-lg border border-border bg-[var(--panel)] px-3 py-2 text-sm leading-[1.55]",
          "border-amber-400/30"
        )}
      >
        {renderMarkdownBlock(text, { className: "gap-2" })}
      </div>
    </article>
  );
}

export function ToolEventRow({ message }: { message: Message }) {
  return <ToolEventGroup messages={[message]} />;
}

interface ToolEventSummary {
  name: string;
  status: string;
  input: unknown;
  result: unknown;
  error?: string;
  callText?: string;
  outputText?: string;
  preview: string;
  isFailure: boolean;
  statusLabel: string;
  toneClass: string;
  showStatusBadge: boolean;
  itemType?: string;
}

function readToolEventSummary(messages: Message[]): ToolEventSummary {
  const toolCalls = messages.filter((message) => message.kind === "tool_call");
  const toolOutputs = messages.filter((message) => message.kind === "tool_output");
  const firstCall = toolCalls.at(0) ?? messages.at(0);
  const lastCall = toolCalls.at(-1) ?? firstCall;
  const lastOutput = toolOutputs.at(-1);
  const lastMessage = lastOutput ?? lastCall ?? messages.at(-1);
  const firstCallPayload = readObject(firstCall?.payload);
  const lastCallPayload = readObject(lastCall?.payload);
  const outputPayload = readObject(lastOutput?.payload);
  const lastPayload = readObject(lastMessage?.payload);
  const metadata = readObject(lastPayload.metadata);
  const callMetadata = readObject(lastCallPayload.metadata);
  const itemType =
    readStringField(callMetadata, "itemType") ?? readStringField(metadata, "itemType");
  const name =
    itemType ??
    readStringField(firstCallPayload, "name") ??
    readStringField(firstCallPayload, "title") ??
    readStringField(lastPayload, "name") ??
    readStringField(lastPayload, "title") ??
    "tool";
  const status =
    readStringField(outputPayload, "status") ??
    readStringField(lastCallPayload, "status") ??
    readStringField(metadata, "status") ??
    readStringField(metadata, "phase") ??
    "started";
  const input = firstCallPayload.input ?? outputPayload.input;
  const result = outputPayload.result;
  const error = readStringField(outputPayload, "error") ?? readStringField(lastPayload, "error");
  const callText =
    readStringField(firstCallPayload, "text") ?? readStringField(lastCallPayload, "text");
  const outputText = readStringField(outputPayload, "text");
  const body = error ?? result ?? outputText ?? callText ?? input;
  const preview = body === undefined ? "" : summarizeValue(body);
  const isFailure = status === "failed" || Boolean(error);
  const statusLabel = humanizeStatus(status);
  const toneClass = toolStatusTone(status, isFailure);
  const showStatusBadge = !isCompletedToolStatus(status) || isFailure;

  return {
    name,
    status,
    input,
    result,
    error,
    callText,
    outputText,
    preview,
    isFailure,
    statusLabel,
    toneClass,
    showStatusBadge,
    itemType
  };
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function normalizeShellCommand(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/);
  return (match?.[2] ?? trimmed).trim();
}

function commandPreview(text: string): string {
  const command = normalizeShellCommand(text).replace(/\s+/g, " ");
  return command.length > 120 ? `${command.slice(0, 117)}...` : command;
}

type ToolActivityKind = CommandIntent | "edit" | "other";

function toolActivityKind(summary: ToolEventSummary): ToolActivityKind {
  const itemType = summary.itemType?.toLowerCase() ?? "";
  if (itemType.includes("filesearch")) {
    return "search";
  }
  if (itemType.includes("filechange")) {
    return "edit";
  }
  if (itemType.includes("command")) {
    return getCommandIntent(normalizeShellCommand(summary.callText ?? summary.preview));
  }
  return "other";
}

function formatToolActivityPart(kind: ToolActivityKind, count: number): string {
  switch (kind) {
    case "search":
      return `explored ${plural(count, "search", "searches")}`;
    case "read":
      return `explored ${plural(count, "file")}`;
    case "test":
      return count === 1 ? "ran tests" : `ran ${count} test commands`;
    case "build":
      return count === 1 ? "ran a build" : `ran ${count} build commands`;
    case "git":
      return count === 1 ? "checked git state" : `checked git state ${count} times`;
    case "edit":
      return `edited ${plural(count, "file")}`;
    case "command":
      return `ran ${plural(count, "command")}`;
    default:
      return `used ${plural(count, "tool")}`;
  }
}

function formatToolClusterSummary(summaries: ToolEventSummary[]): string {
  if (summaries.length === 1) {
    const [summary] = summaries;
    if (summary?.callText && toolActivityKind(summary) === "command") {
      return `Ran ${commandPreview(summary.callText)}`;
    }
  }

  const counts = new Map<ToolActivityKind, number>();
  for (const summary of summaries) {
    const kind = toolActivityKind(summary);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([kind, count], index) => {
      const part = formatToolActivityPart(kind, count);
      return index === 0 ? part.replace(/^\w/, (char) => char.toUpperCase()) : part;
    })
    .join(", ");
}

function ToolEventCluster({
  tools
}: {
  tools: Extract<ThreadDisplayItem, { type: "tool" }>[];
}) {
  const summaries = tools.map((tool) => readToolEventSummary(tool.messages));
  const hasFailure = summaries.some((summary) => summary.isFailure);
  const summaryLabel = formatToolClusterSummary(summaries);
  const [expanded, setExpanded] = useState(() => hasFailure);

  if (!expanded) {
    return (
      <article className="w-full max-w-[min(44rem,96%)] px-1 py-0.5">
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius)] px-1 py-0.5 text-left text-[0.78rem] font-[510] text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--muted-strong)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
        >
          <span className="min-w-0 truncate">{summaryLabel}</span>
          <span className="grid size-4 shrink-0 place-items-center">
            <ChevronDown className="size-3" aria-hidden="true" />
          </span>
        </button>
      </article>
    );
  }

  return (
    <article className="w-full max-w-[min(44rem,96%)] px-1 py-0.5">
      <div className="grid gap-1.5">
        <div className="grid gap-1.5">
          {tools.map((tool, index) => (
            <ToolEventGroup
              key={tool.id}
              messages={tool.messages}
              nested
              forceOpen={index === 0 && hasFailure}
            />
          ))}
        </div>
        <div className="flex justify-start">
          <button
            type="button"
            className="inline-flex min-h-6 justify-self-start items-center gap-1 rounded-[var(--radius)] px-2 text-[0.66rem] font-[510] text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground focus-visible:border focus-visible:border-[var(--accent)] focus-visible:outline-none"
            onClick={() => setExpanded(false)}
          >
            <ChevronUp className="size-3" aria-hidden="true" />
            Collapse
          </button>
        </div>
      </div>
    </article>
  );
}

function ToolSummaryLine({
  summary,
  badgeLabel,
  trailing,
  className
}: {
  summary: ToolEventSummary;
  badgeLabel?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 px-2 py-1 text-muted-foreground",
        className
      )}
    >
      <span
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-[var(--radius)] border",
          summary.toneClass
        )}
      >
        <ToolStatusIcon status={summary.status} isFailure={summary.isFailure} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="inline-flex max-w-[10rem] shrink-0 items-center truncate rounded-full border border-border bg-[var(--surface-soft)] px-1.5 py-0.5 text-[0.6rem] font-[510] leading-none text-[var(--muted-strong)]">
          {badgeLabel ?? humanizeToolName(summary.name)}
        </span>
        {summary.preview ? (
          <span className="min-w-0 truncate font-mono text-[0.68rem] leading-[1.35] text-[var(--muted)]">
            {summary.preview}
          </span>
        ) : null}
        {summary.showStatusBadge ? (
          <span
            className={cn(
              "inline-flex min-h-4 shrink-0 items-center rounded-full border px-1.5 text-[0.56rem] font-medium leading-none",
              summary.toneClass
            )}
          >
            {summary.statusLabel}
          </span>
        ) : null}
      </span>
      <span className="grid size-5 place-items-center rounded-[var(--radius)] text-[var(--muted)] transition-colors group-hover:bg-[var(--surface-hover)] group-hover:text-foreground">
        {trailing}
      </span>
    </span>
  );
}

function ToolEventGroup({
  messages,
  nested = false,
  forceOpen = false
}: {
  messages: Message[];
  nested?: boolean;
  forceOpen?: boolean;
}) {
  const summary = readToolEventSummary(messages);
  const { input, result, error, callText, outputText, isFailure } = summary;

  const details = (
      <details
        open={forceOpen || isFailure}
        className={cn(
          "group rounded-[var(--radius)] border bg-[var(--surface-faint)] transition-colors",
          isFailure
            ? "border-[rgba(239,98,108,0.28)]"
            : "border-border hover:border-[var(--border-strong)] hover:bg-[var(--surface-soft)]"
        )}
      >
        <summary className="cursor-pointer list-none">
          <ToolSummaryLine
            summary={summary}
            trailing={
              <ChevronDown
                className="size-3 transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            }
          />
        </summary>
        <div className="grid gap-2 border-t border-border px-2 py-2">
          {callText ? <ToolJsonBlock label="Command" value={callText} /> : null}
          {input !== undefined ? <ToolJsonBlock label="Input" value={input} /> : null}
          {result !== undefined ? <ToolJsonBlock label="Result" value={result} /> : null}
          {outputText ? <ToolJsonBlock label="Output" value={outputText} /> : null}
          {error ? <ToolJsonBlock label="Error" value={error} tone="danger" /> : null}
        </div>
      </details>
  );

  if (nested) {
    return <div className="w-full">{details}</div>;
  }

  return <article className="w-full max-w-[min(44rem,96%)] px-1 py-0.5">{details}</article>;
}

function ToolJsonBlock({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: unknown;
  tone?: "default" | "danger";
}) {
  return (
    <div className="grid gap-1">
      <span className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <pre
        className={cn(
          "m-0 overflow-x-auto rounded-[var(--radius)] border border-border bg-[var(--panel)] px-2 py-1.5 font-mono text-[0.68rem] leading-[1.6] whitespace-pre-wrap break-words",
          tone === "danger" && "text-[var(--danger)]"
        )}
      >
        {stringifyValue(value)}
      </pre>
    </div>
  );
}

function StatusRow({ message }: { message: Message }) {
  const text = readText(message.payload);
  return (
    <article className="grid gap-1">
      <Meta message={message} />
      <div className="rounded-md border border-indigo-400/30 bg-indigo-400/5 px-3 py-1.5 text-xs text-muted-foreground">
        {text || <ArtifactPreview payload={message.payload} />}
      </div>
    </article>
  );
}

function RequestUserInputRow({
  message,
  threadId
}: {
  message: Message;
  threadId: string;
}) {
  const postMessage = usePostThreadMessage(threadId);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);

  const handleSelect = async (option: string) => {
    setSelectedOption(option);
    try {
      await postMessage.mutateAsync({ content: option, kind: "chat" });
    } catch (error) {
      setSelectedOption(null);
      toast({
        title: "Couldn't send response",
        description: readErrorMessage(error, "Unable to send your response."),
        variant: "destructive"
      });
    }
  };

  return (
    <RequestUserInputCard
      message={message}
      selectedOption={selectedOption}
      isPending={postMessage.isPending}
      onSelect={(option) => {
        void handleSelect(option);
      }}
    />
  );
}

export function RequestUserInputCard({
  message,
  selectedOption,
  isPending = false,
  onSelect
}: {
  message: Message;
  selectedOption?: string | null;
  isPending?: boolean;
  onSelect?: (option: string) => void;
}) {
  const payload = readObject(message.payload);
  const question = readStringField(payload, "question") ?? "";
  const options = readStringArrayField(payload, "options");
  const hasSelection = Boolean(selectedOption);

  return (
    <article className="grid gap-1.5">
      <Meta message={message} />
      <div className="grid max-w-[min(42rem,96%)] gap-3 rounded-lg border border-amber-400/35 bg-amber-400/10 px-3 py-3 text-sm">
        <p className="m-0 leading-[1.55] text-foreground">{question}</p>
        {options.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {options.map((option) => {
              const isSelected = option === selectedOption;
              return (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={isSelected ? "default" : "secondary"}
                  disabled={isPending || hasSelection}
                  onClick={() => onSelect?.(option)}
                  className="max-w-full justify-start whitespace-normal text-left leading-snug"
                >
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  <span>{option}</span>
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ArtifactRow({ message }: { message: Message }) {
  return (
    <article className="grid gap-1.5">
      <Meta message={message} />
      <details className="rounded-md border border-border bg-[var(--panel)]">
        <summary className="cursor-pointer list-none px-3 py-1.5 text-xs font-medium">
          Artifact
        </summary>
        <div className="border-t border-border px-3 py-2">
          <ArtifactPreview payload={message.payload} />
        </div>
      </details>
    </article>
  );
}

function ArtifactPreview({ payload }: { payload: unknown }) {
  return (
    <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words text-[0.72rem] leading-[1.5] text-muted-foreground">
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}

function PlanDraftRow({
  message,
  threadId
}: {
  message: Message;
  threadId: string;
}) {
  const planId =
    message.payload && typeof message.payload === "object" && "planId" in message.payload
      ? String((message.payload as { planId?: unknown }).planId ?? "")
      : "";
  const planQuery = usePlan(planId || null);

  return (
    <article className="grid gap-1.5">
      <Meta message={message} />
      {planQuery.isLoading ? (
        <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          Loading plan…
        </div>
      ) : planQuery.data ? (
        <PlanDraftCard plan={planQuery.data} threadId={threadId} />
      ) : (
        <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          Plan no longer available.
        </div>
      )}
    </article>
  );
}

function PlanDecisionRow({ message }: { message: Message }) {
  const payload = (message.payload ?? {}) as {
    decision?: string;
    reason?: string;
  };
  const decision = payload.decision ?? "decided";
  const tone =
    decision === "approve"
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-100"
      : decision === "reject"
        ? "border-rose-400/40 bg-rose-400/10 text-rose-100"
        : "border-slate-400/40 bg-slate-400/10 text-slate-100";
  return (
    <article className="grid gap-1">
      <Meta message={message} />
      <div
        className={cn(
          "rounded-md border px-3 py-1.5 text-xs",
          tone
        )}
      >
        Plan {decision}
        {payload.reason ? ` — ${payload.reason}` : ""}
      </div>
    </article>
  );
}

function SystemEventRow({ message }: { message: Message }) {
  const payload = readObject(message.payload);
  const eventName =
    readStringField(payload, "event") ?? readStringField(payload, "text") ?? "event";
  return (
    <article className="flex items-center gap-2 px-1 text-[0.68rem] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="font-mono uppercase tracking-wide">
        {eventName}
      </span>
      <span>{formatRelativeTime(message.createdAt)}</span>
      <span className="h-px flex-1 bg-border" />
    </article>
  );
}

function isStatusDivider(message: Message): boolean {
  if (message.kind !== "status") {
    return false;
  }

  const payload = readObject(message.payload);
  return readStringField(payload, "kind") === "coordinator_restart";
}

function isUserFacing(message: Message): boolean {
  return message.sender.type === "user" || message.kind === "system_event";
}
