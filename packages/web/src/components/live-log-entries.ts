import type { RunLogEntry } from "@workhorse/contracts";

export const ENTRY_LABELS: Record<RunLogEntry["kind"], string> = {
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

export interface LiveLogDisplayGroups {
  streamEntries: RunLogEntry[];
}

export type LiveLogStreamItem =
  | {
      type: "entry";
      entry: RunLogEntry;
    }
  | {
      type: "tool";
      entry: RunLogEntry;
      outputEntries: RunLogEntry[];
    };

export function metadataEntries(entry: RunLogEntry): Array<[string, string]> {
  return Object.entries(entry.metadata ?? {}).filter(
    (field): field is [string, string] => {
      const [key, value] = field;
      return !HIDDEN_METADATA_KEYS.has(key) && typeof value === "string" && value.trim().length > 0;
    }
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

export function humanizeIdentifier(value: string): string {
  const expanded = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_/.-]+/g, " ")
    .trim()
    .toLowerCase();

  return expanded.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function normalizeToolTitle(entry: RunLogEntry): string {
  const itemType = entry.metadata?.itemType;
  if (itemType) {
    return humanizeIdentifier(itemType);
  }

  const title = entry.title?.replace(/\s+(started|completed)$/i, "").trim();
  if (title && title.length > 0) {
    return title;
  }

  return ENTRY_LABELS[entry.kind] ?? "Log Entry";
}

export function isCommandExecutionEntry(entry: RunLogEntry): boolean {
  if (entry.kind !== "tool_call") {
    return false;
  }

  const itemType = entry.metadata?.itemType?.toLowerCase();
  if (itemType) {
    return itemType.includes("command");
  }

  return normalizeToolTitle(entry).toLowerCase() === "command execution";
}

function normalizeStatusTone(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s/.-]+/g, "-")
    .toLowerCase();
}

export function getToolStatus(entry: RunLogEntry): { label: string; tone: string } | null {
  if (entry.kind !== "tool_call") {
    return null;
  }

  const value = entry.metadata?.status ?? entry.metadata?.phase;
  if (!value) {
    return null;
  }

  return {
    label: humanizeIdentifier(value),
    tone: normalizeStatusTone(value)
  };
}

function isToolLifecycleMatch(left: RunLogEntry, right: RunLogEntry): boolean {
  if (left.kind !== "tool_call" || right.kind !== "tool_call") {
    return false;
  }

  if (right.metadata?.phase !== "completed") {
    return false;
  }

  const leftGroupId = left.metadata?.groupId;
  const rightGroupId = right.metadata?.groupId;
  if (leftGroupId && rightGroupId) {
    return leftGroupId === rightGroupId && left.metadata?.phase !== "completed";
  }

  return (
    left.metadata?.phase === "started" &&
    left.metadata?.itemType === right.metadata?.itemType &&
    right.text.startsWith(left.text)
  );
}

function canMergeEntries(left: RunLogEntry, right: RunLogEntry): boolean {
  if (left.kind === "tool_call" && right.kind === "tool_call") {
    return isToolLifecycleMatch(left, right);
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

function findToolLifecycleEntryIndex(
  entries: RunLogEntry[],
  entry: RunLogEntry
): number {
  if (entry.kind !== "tool_call") {
    return -1;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (!candidate || !isToolLifecycleMatch(candidate, entry)) {
      continue;
    }

    return index;
  }

  return -1;
}

export function aggregateEntries(entries: RunLogEntry[]): RunLogEntry[] {
  return entries.reduce<RunLogEntry[]>((acc, entry) => {
    const toolLifecycleIndex = findToolLifecycleEntryIndex(acc, entry);
    if (toolLifecycleIndex >= 0) {
      const existing = acc[toolLifecycleIndex];
      const merged = existing ? mergeEntries(existing, entry) : null;
      if (merged) {
        acc[toolLifecycleIndex] = merged;
        return acc;
      }
    }

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

export function prepareLiveLogEntries(entries: RunLogEntry[]): RunLogEntry[] {
  const seen = new Set<string>();

  return aggregateEntries(
    entries
      .filter((entry) => {
        if (seen.has(entry.id)) {
          return false;
        }

        seen.add(entry.id);
        return true;
      })
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .map((entry) => ({
        ...entry,
        metadata: entry.metadata ? { ...entry.metadata } : undefined
      }))
  );
}

export function partitionLiveLogEntries(
  entries: RunLogEntry[]
): LiveLogDisplayGroups {
  return entries.reduce<LiveLogDisplayGroups>(
    (groups, entry) => {
      groups.streamEntries.push(entry);
      return groups;
    },
    {
      streamEntries: []
    }
  );
}

export function buildLiveLogStreamItems(entries: RunLogEntry[]): LiveLogStreamItem[] {
  const items: LiveLogStreamItem[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    if (entry.kind === "tool_output") {
      const groupId = entry.metadata?.groupId;
      if (groupId) {
        const toolItem = [...items]
          .reverse()
          .find(
            (item): item is Extract<LiveLogStreamItem, { type: "tool" }> =>
              item.type === "tool" && item.entry.metadata?.groupId === groupId
          );

        if (toolItem) {
          toolItem.outputEntries.push(entry);
          continue;
        }
      }

      const lastItem = items.at(-1);
      if (lastItem?.type === "tool") {
        lastItem.outputEntries.push(entry);
        continue;
      }
    }

    if (entry.kind !== "tool_call") {
      items.push({
        type: "entry",
        entry
      });
      continue;
    }

    items.push({
      type: "tool",
      entry,
      outputEntries: []
    });
  }

  return items;
}
