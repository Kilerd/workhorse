import { useMemo, useState } from "react";

import { formatRelativeTime, titleCase } from "@/lib/format";
import type { CoordinationMessage } from "@/lib/coordination";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  messages: CoordinationMessage[];
  loading?: boolean;
  error?: string | null;
  onSendMessage?(content: string): Promise<unknown>;
  title?: string;
  description?: string;
  emptyStateLabel?: string;
  composerLabel?: string;
  placeholder?: string;
  unavailablePlaceholder?: string;
  footerHint?: string;
  fullHeight?: boolean;
}

interface ArtifactPayload {
  files_changed?: string[];
  diff_summary?: string;
  pr_url?: string | null;
  test_results?: string | null;
}

const MAX_HUMAN_TEAM_MESSAGE_LENGTH = 10_240;

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function parseArtifactPayload(content: string): ArtifactPayload | null {
  try {
    const parsed = JSON.parse(content) as ArtifactPayload;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function messageTone(message: CoordinationMessage) {
  switch (message.messageType) {
    case "artifact":
      return "border-[rgba(122,127,173,0.22)] bg-[rgba(122,127,173,0.08)]";
    case "status":
      return "border-[rgba(113,112,255,0.26)] bg-[rgba(113,112,255,0.08)]";
    case "feedback":
      return "border-[rgba(214,164,73,0.24)] bg-[rgba(214,164,73,0.08)]";
    default:
      return "border-border bg-[var(--panel)]";
  }
}

function senderTone(senderType: CoordinationMessage["senderType"]) {
  switch (senderType) {
    case "agent":
      return "tone-accent";
    case "system":
      return "tone-muted";
    default:
      return "tone-warning";
  }
}

export function TeamMessageFeed({
  messages,
  loading = false,
  error = null,
  onSendMessage,
  title = "Coordination Feed",
  description = "Live execution context for the current coordination thread.",
  emptyStateLabel = "No coordination messages yet for this task thread.",
  composerLabel = "Human reply",
  placeholder = "Leave feedback for the coordinator or running agents...",
  unavailablePlaceholder = "Coordination message input is unavailable.",
  footerHint = "Press Ctrl/Cmd+Enter to send.",
  fullHeight = false
}: Props) {
  const [draft, setDraft] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "sending" | "failed">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const orderedMessages = useMemo(
    () =>
      [...messages].sort(
        (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
      ),
    [messages]
  );

  async function handleSendMessage() {
    const content = draft.trim();
    if (!content || !onSendMessage) {
      return;
    }

    setSubmitState("sending");
    setSubmitError(null);

    try {
      await onSendMessage(content);
      setDraft("");
      setSubmitState("idle");
    } catch (nextError) {
      setSubmitState("failed");
      setSubmitError(
        nextError instanceof Error ? nextError.message : "Unable to send coordination message."
      );
    }
  }

  return (
    <section
      className={cn(
        "grid gap-3",
        fullHeight && "h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="section-kicker m-0">
            {title}
          </p>
          <p className="m-0 mt-1 text-[0.82rem] text-[var(--muted)]">
            {description}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="text-[0.76rem] text-[var(--muted)]">Loading coordination activity…</div>
      ) : error ? (
        <div className="text-[0.76rem] text-[var(--danger)]">{error}</div>
      ) : orderedMessages.length === 0 ? (
        <div className="rounded-[var(--radius)] border border-dashed border-border px-4 py-5 text-[0.84rem] text-[var(--muted)]">
          {emptyStateLabel}
        </div>
      ) : (
        <div
          className={cn(
            "grid gap-2 overflow-y-auto pr-1",
            fullHeight ? "min-h-0" : "max-h-[22rem]"
          )}
        >
          {orderedMessages.map((message) => {
            const artifact = message.messageType === "artifact"
              ? parseArtifactPayload(message.content)
              : null;
            const safeArtifactUrl =
              artifact?.pr_url && isSafeUrl(artifact.pr_url) ? artifact.pr_url : null;

            return (
              <article
                key={message.id}
                className={cn(
                  "grid gap-3 rounded-[var(--radius)] border p-4",
                  messageTone(message),
                  message.senderType === "human" &&
                    "ml-auto w-full max-w-[min(34rem,92%)] justify-self-end"
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex min-h-7 items-center rounded-full border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em]",
                      senderTone(message.senderType)
                    )}
                  >
                    {message.senderType} · {message.agentName}
                  </span>
                  <span className="inline-flex min-h-7 items-center rounded-full border border-border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                    {message.messageType}
                  </span>
                  <span className="text-[0.74rem] text-[var(--muted)]">
                    {formatRelativeTime(message.createdAt)}
                  </span>
                </div>

                {artifact ? (
                  <details className="rounded-[var(--radius)] border border-border bg-[var(--bg)]">
                    <summary className="cursor-pointer list-none px-4 py-3 text-[0.84rem] font-medium">
                      Artifact payload
                    </summary>
                    <div className="grid gap-3 border-t border-border px-4 py-4 text-[0.84rem]">
                      <div className="grid gap-1">
                        <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                          Files changed
                        </span>
                        {artifact.files_changed?.length ? (
                          <div className="flex flex-wrap gap-1.5">
                            {artifact.files_changed.map((file) => (
                              <code
                                key={file}
                                className="rounded-full border border-border px-2 py-1 text-[0.72rem]"
                              >
                                {file}
                              </code>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[var(--muted)]">None reported</span>
                        )}
                      </div>

                      <div className="grid gap-1">
                        <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                          Diff summary
                        </span>
                        <pre className="overflow-x-auto whitespace-pre-wrap rounded-[var(--radius)] border border-border bg-[var(--panel)] px-3 py-3 font-mono text-[0.72rem]">
                          {artifact.diff_summary || "No diff summary"}
                        </pre>
                      </div>

                      <div className="grid gap-1">
                        <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                          Test results
                        </span>
                        <span>{artifact.test_results ?? "Not provided"}</span>
                      </div>

                      {artifact.pr_url ? (
                        safeArtifactUrl ? (
                          <a
                            href={safeArtifactUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="break-all text-[var(--accent)] no-underline hover:underline"
                          >
                            {safeArtifactUrl}
                          </a>
                        ) : (
                          <span className="break-all text-[var(--muted)]">
                            {artifact.pr_url}
                          </span>
                        )
                      ) : null}
                    </div>
                  </details>
                ) : (
                  <p className="m-0 whitespace-pre-wrap break-words text-[0.88rem] leading-[1.65] text-foreground">
                    {message.content}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]">
            {composerLabel}
          </span>
          <span className="text-[0.74rem] text-[var(--muted)]">
            {titleCase(onSendMessage ? "feedback message" : "unavailable")}
          </span>
        </div>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSendMessage();
          }}
        >
          <Textarea
            rows={3}
            value={draft}
            maxLength={MAX_HUMAN_TEAM_MESSAGE_LENGTH}
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
                void handleSendMessage();
              }
            }}
            disabled={!onSendMessage || submitState === "sending"}
            placeholder={
              onSendMessage
                ? placeholder
                : unavailablePlaceholder
            }
            className="min-h-20 resize-y"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-[0.68rem] text-[var(--muted)]">
            <span>
              {footerHint} {draft.length}/{MAX_HUMAN_TEAM_MESSAGE_LENGTH}
            </span>
            <Button
              type="submit"
              disabled={!onSendMessage || submitState === "sending" || draft.trim().length === 0}
            >
              {submitState === "sending" ? "Sending..." : "Send"}
            </Button>
          </div>
          {submitError ? (
            <div className="text-[0.72rem] text-[var(--danger)]">{submitError}</div>
          ) : null}
        </form>
      </div>
    </section>
  );
}
