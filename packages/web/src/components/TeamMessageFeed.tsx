import { useMemo, useState } from "react";
import type { TeamMessage } from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  messages: TeamMessage[];
  loading?: boolean;
  error?: string | null;
  onSendMessage?(content: string): Promise<unknown>;
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

function messageTone(message: TeamMessage) {
  switch (message.messageType) {
    case "artifact":
      return "border-[rgba(104,199,246,0.24)] bg-[rgba(104,199,246,0.08)]";
    case "status":
      return "border-[rgba(73,214,196,0.26)] bg-[rgba(73,214,196,0.08)]";
    case "feedback":
      return "border-[rgba(242,195,92,0.26)] bg-[rgba(242,195,92,0.08)]";
    default:
      return "border-border bg-[var(--panel)]";
  }
}

function senderTone(senderType: TeamMessage["senderType"]) {
  switch (senderType) {
    case "agent":
      return "border-[rgba(73,214,196,0.24)] bg-[rgba(73,214,196,0.1)] text-[var(--accent-strong)]";
    case "system":
      return "border-[rgba(128,146,152,0.24)] bg-[rgba(128,146,152,0.08)] text-[var(--muted)]";
    default:
      return "border-[rgba(242,195,92,0.24)] bg-[rgba(242,195,92,0.08)] text-[var(--warning)]";
  }
}

export function TeamMessageFeed({
  messages,
  loading = false,
  error = null,
  onSendMessage
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
        nextError instanceof Error ? nextError.message : "Unable to send team message."
      );
    }
  }

  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="m-0 font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent)]">
            Team Message Feed
          </p>
          <p className="m-0 mt-1 text-[0.72rem] text-[var(--muted)]">
            Live execution context for the current parent task.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="text-[0.76rem] text-[var(--muted)]">Loading team activity…</div>
      ) : error ? (
        <div className="text-[0.76rem] text-[var(--danger)]">{error}</div>
      ) : orderedMessages.length === 0 ? (
        <div className="rounded-none border border-dashed border-border px-3 py-4 text-[0.74rem] text-[var(--muted)]">
          No team messages yet for this task thread.
        </div>
      ) : (
        <div className="grid max-h-[22rem] gap-2 overflow-y-auto pr-1">
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
                  "grid gap-2 rounded-none border p-3",
                  messageTone(message),
                  message.senderType === "human" &&
                    "ml-auto w-full max-w-[min(34rem,92%)] justify-self-end"
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex min-h-5 items-center rounded-none border px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.1em]",
                      senderTone(message.senderType)
                    )}
                  >
                    {message.senderType} · {message.agentName}
                  </span>
                  <span className="inline-flex min-h-5 items-center rounded-none border border-border px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.1em] text-[var(--muted)]">
                    {message.messageType}
                  </span>
                  <span className="text-[0.68rem] text-[var(--muted)]">
                    {formatRelativeTime(message.createdAt)}
                  </span>
                </div>

                {artifact ? (
                  <details className="rounded-none border border-border bg-[var(--bg)]">
                    <summary className="cursor-pointer list-none px-3 py-2 text-[0.74rem] font-medium">
                      Artifact payload
                    </summary>
                    <div className="grid gap-3 border-t border-border px-3 py-3 text-[0.74rem]">
                      <div className="grid gap-1">
                        <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--muted)]">
                          Files changed
                        </span>
                        {artifact.files_changed?.length ? (
                          <div className="flex flex-wrap gap-1.5">
                            {artifact.files_changed.map((file) => (
                              <code
                                key={file}
                                className="rounded-none border border-border px-1.5 py-0.5 text-[0.68rem]"
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
                        <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--muted)]">
                          Diff summary
                        </span>
                        <pre className="overflow-x-auto whitespace-pre-wrap rounded-none border border-border bg-[var(--panel)] px-2 py-2 font-mono text-[0.66rem]">
                          {artifact.diff_summary || "No diff summary"}
                        </pre>
                      </div>

                      <div className="grid gap-1">
                        <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--muted)]">
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
                  <p className="m-0 whitespace-pre-wrap break-words text-[0.76rem] leading-[1.55] text-foreground">
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
          <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--muted)]">
            Human reply
          </span>
          <span className="text-[0.68rem] text-[var(--muted)]">
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
                ? "Leave feedback for the coordinator or running agents..."
                : "Team message input is unavailable."
            }
            className="min-h-20 resize-y"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-[0.68rem] text-[var(--muted)]">
            <span>
              Press Ctrl/Cmd+Enter to send. v1 records the message only. {draft.length}/
              {MAX_HUMAN_TEAM_MESSAGE_LENGTH}
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
