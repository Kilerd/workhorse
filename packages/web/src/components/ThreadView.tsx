import { useMemo, useState } from "react";
import type { Message, Thread } from "@workhorse/contracts";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { usePlan } from "@/hooks/usePlans";
import {
  useThreadMessages,
  usePostThreadMessage
} from "@/hooks/useThreads";
import { readErrorMessage } from "@/lib/error-message";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { PlanDraftCard } from "./PlanDraftCard";

interface Props {
  threadId: string;
  /** Optional; when provided enables the coordinator-state hint. */
  thread?: Thread | null;
  className?: string;
}

const MAX_CHAT_LENGTH = 10_240;

export function ThreadView({ threadId, thread, className }: Props) {
  const messagesQuery = useThreadMessages(threadId);
  const postMessage = usePostThreadMessage(threadId);

  const [draft, setDraft] = useState("");

  const ordered = useMemo(() => {
    const items = messagesQuery.data ?? [];
    return [...items].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    );
  }, [messagesQuery.data]);

  const pendingCount = useMemo(
    () => ordered.filter((m) => isUserFacing(m) && !m.consumedByRunId).length,
    [ordered]
  );

  async function handleSend() {
    const content = draft.trim();
    if (!content) return;
    try {
      await postMessage.mutateAsync({ content, kind: "chat" });
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
          No messages yet. Start the conversation below.
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-max content-start gap-2 overflow-y-auto pr-1">
          {ordered.map((msg) => (
            <MessageRow key={msg.id} message={msg} threadId={threadId} />
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
          placeholder="Message this thread…"
          disabled={postMessage.isPending}
          className="min-h-20 resize-y"
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Cmd/Ctrl+Enter · {draft.length}/{MAX_CHAT_LENGTH}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={postMessage.isPending || draft.trim().length === 0}
          >
            {postMessage.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
    </section>
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

function MessageRow({ message, threadId }: { message: Message; threadId: string }) {
  switch (message.kind) {
    case "chat":
      return <ChatRow message={message} />;
    case "status":
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

function senderLabel(message: Message): string {
  if (message.sender.type === "user") return "you";
  if (message.sender.type === "system") return "system";
  return `@${message.sender.agentId}`;
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
        {senderLabel(message)}
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

function ChatRow({ message }: { message: Message }) {
  const text = readText(message.payload);
  const isUser = message.sender.type === "user";
  return (
    <article
      className={cn(
        "grid gap-1.5",
        isUser ? "ml-auto max-w-[min(34rem,92%)] justify-items-end" : "max-w-[min(48rem,94%)]"
      )}
    >
      <Meta message={message} align={isUser ? "end" : undefined} />
      <div
        className={cn(
          "rounded-lg border border-border bg-[var(--panel)] px-3 py-2 text-sm leading-[1.55]",
          isUser && "border-amber-400/30"
        )}
      >
        <p className="m-0 whitespace-pre-wrap break-words">{text}</p>
      </div>
    </article>
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
  const payload = (message.payload ?? {}) as { event?: string };
  const eventName = payload.event ?? "event";
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

function isUserFacing(message: Message): boolean {
  return message.sender.type === "user" || message.kind === "system_event";
}
