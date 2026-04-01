import { useMemo } from "react";
import type { Run, RunLogEntry, Task } from "@workhorse/contracts";

interface Props {
  task: Task;
  activeRun: Run | null;
  viewedRun: Run | null;
  liveLog: RunLogEntry[];
  runLog: RunLogEntry[];
  isLoading?: boolean;
  showStatus?: boolean;
}

const ENTRY_LABELS: Record<RunLogEntry["kind"], string> = {
  text: "Output",
  agent: "Agent",
  tool_call: "Tool",
  tool_output: "Tool Output",
  plan: "Plan",
  system: "System",
  status: "Status"
};

const HIDDEN_METADATA_KEYS = new Set([
  "groupId",
  "itemId",
  "turnId",
  "threadId",
  "phase",
  "itemType"
]);

function metadataEntries(entry: RunLogEntry): Array<[string, string]> {
  return Object.entries(entry.metadata ?? {}).filter(
    ([key, value]) => !HIDDEN_METADATA_KEYS.has(key) && value.trim().length > 0
  );
}

function sameMetadata(
  left?: Record<string, string>,
  right?: Record<string, string>
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([key, value], index) => {
    const [otherKey, otherValue] = rightEntries[index] ?? [];
    return key === otherKey && value === otherValue;
  });
}

function canMergeEntries(left: RunLogEntry, right: RunLogEntry): boolean {
  if (left.kind === "tool_call" && right.kind === "tool_call") {
    const leftGroupId = left.metadata?.groupId;
    const rightGroupId = right.metadata?.groupId;
    if (leftGroupId && rightGroupId) {
      return leftGroupId === rightGroupId;
    }

    return (
      left.metadata?.phase === "started" &&
      right.metadata?.phase === "completed" &&
      left.metadata?.itemType === right.metadata?.itemType &&
      right.text.startsWith(left.text)
    );
  }

  if (!["agent", "text", "tool_output", "system"].includes(left.kind)) {
    return false;
  }

  if (left.kind !== right.kind) {
    return false;
  }

  if (
    left.stream !== right.stream ||
    left.title !== right.title ||
    left.source !== right.source
  ) {
    return false;
  }

  const leftGroupId = left.metadata?.groupId;
  const rightGroupId = right.metadata?.groupId;
  if (leftGroupId || rightGroupId) {
    return leftGroupId === rightGroupId;
  }

  return sameMetadata(left.metadata, right.metadata);
}

function humanizeIdentifier(value: string): string {
  const expanded = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_/.-]+/g, " ")
    .trim()
    .toLowerCase();

  return expanded.replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeToolTitle(entry: RunLogEntry): string {
  const itemType = entry.metadata?.itemType;
  if (itemType) {
    return humanizeIdentifier(itemType);
  }

  const title = entry.title?.replace(/\s+(started|completed)$/i, "").trim();
  return title && title.length > 0 ? title : ENTRY_LABELS[entry.kind];
}

function mergeToolText(leftText: string, rightText: string): string {
  const next = rightText.trimEnd();
  const previous = leftText.trimEnd();

  if (!previous) {
    return rightText;
  }

  if (!next) {
    return leftText;
  }

  if (next.startsWith(previous)) {
    return rightText;
  }

  if (previous.startsWith(next)) {
    return leftText;
  }

  return `${previous}\n${next}`;
}

function mergeEntries(left: RunLogEntry, right: RunLogEntry): RunLogEntry | null {
  if (!canMergeEntries(left, right)) {
    return null;
  }

  if (left.kind === "tool_call" && right.kind === "tool_call") {
    return {
      ...left,
      title: normalizeToolTitle(right),
      text: mergeToolText(left.text, right.text),
      timestamp: right.timestamp,
      source: right.source ?? left.source,
      metadata: {
        ...(left.metadata ?? {}),
        ...(right.metadata ?? {})
      }
    };
  }

  return {
    ...left,
    text: `${left.text}${right.text}`,
    timestamp: right.timestamp
  };
}

function aggregateEntries(entries: RunLogEntry[]): RunLogEntry[] {
  return entries.reduce<RunLogEntry[]>((acc, entry) => {
    const previous = acc.at(-1);
    if (!previous) {
      acc.push(entry);
      return acc;
    }

    const merged = mergeEntries(previous, entry);
    if (!merged) {
      acc.push(entry);
      return acc;
    }

    acc[acc.length - 1] = merged;
    return acc;
  }, []);
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

export function LiveLog({
  task,
  activeRun,
  viewedRun,
  liveLog,
  runLog,
  isLoading = false,
  showStatus = true
}: Props) {
  const entries = useMemo(() => {
    const merged = [...runLog, ...liveLog];
    const seen = new Set<string>();

    return merged
      .filter((entry) => {
        if (seen.has(entry.id)) {
          return false;
        }
        seen.add(entry.id);
        return true;
      })
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }, [liveLog, runLog]);

  const aggregatedEntries = useMemo(() => {
    return aggregateEntries(
      entries.map((entry) => ({
        ...entry,
        metadata: entry.metadata ? { ...entry.metadata } : undefined
      }))
    );
  }, [entries]);

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
              This run was canceled. That usually means it was stopped manually, or the server restarted while the task was running.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="details-section details-section-log">
        <h3>Live log</h3>
        {!showStatus && viewedRun ? (
          <p className="muted">
            Viewing {viewedRun.status} run {viewedRun.id}
          </p>
        ) : null}
        {aggregatedEntries.length === 0 ? (
          isLoading ? (
            <div className="log-empty">Loading logs...</div>
          ) : (
          <div className="log-empty">
            Logs will appear here when a run starts.
          </div>
          )
        ) : (
          <div className="log-stream">
            {aggregatedEntries.map((entry) => (
              <article
                key={entry.id}
                className={`log-entry log-entry-${entry.kind}`}
              >
                <header className="log-entry-header">
                  <div className="log-entry-title">
                    <span className={`log-kind log-kind-${entry.kind}`}>
                      {ENTRY_LABELS[entry.kind]}
                    </span>
                    {entry.title ? <strong>{entry.kind === "tool_call" ? normalizeToolTitle(entry) : entry.title}</strong> : null}
                  </div>
                  <div className="log-entry-meta">
                    {entry.stream !== "stdout" ? (
                      <span className="log-stream-chip">{entry.stream}</span>
                    ) : null}
                    <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
                  </div>
                </header>
                {metadataEntries(entry).length > 0 ? (
                  <dl className="log-entry-details">
                    {metadataEntries(entry).map(([key, value]) => (
                      <div key={`${entry.id}-${key}`}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <pre className="log-entry-body">{entry.text}</pre>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
