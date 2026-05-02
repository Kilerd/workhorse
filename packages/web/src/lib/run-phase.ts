import type { Message, Run } from "@workhorse/contracts";

export type RunPhase = "coding" | "review";

const REVIEW_TRIGGERS = new Set([
  "ai_review",
  "ai_review_rework",
  "manual_review",
  "auto_ai_review",
  "manual_agent_review",
  "manual_claude_review"
]);

export function classifyRunPhase(run: Run): RunPhase {
  const trigger = run.metadata?.trigger;
  if (trigger && REVIEW_TRIGGERS.has(trigger)) {
    return "review";
  }
  return "coding";
}

function readMessageRunId(message: Message): string | undefined {
  const payload = message.payload as { metadata?: { runId?: unknown } } | undefined;
  const runId = payload?.metadata?.runId;
  return typeof runId === "string" && runId ? runId : undefined;
}

export function messagePhase(
  message: Message,
  runs: Run[]
): RunPhase | "unbound" {
  const runId = readMessageRunId(message);
  if (!runId) {
    return "unbound";
  }
  const run = runs.find((entry) => entry.id === runId);
  if (!run) {
    return "unbound";
  }
  return classifyRunPhase(run);
}

export function buildPhaseFilter(
  runs: Run[],
  phase: RunPhase
): (message: Message) => boolean {
  return (message) => {
    const resolved = messagePhase(message, runs);
    if (resolved === "unbound") {
      return phase === "coding";
    }
    return resolved === phase;
  };
}
