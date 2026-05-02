import type { Message } from "@workhorse/contracts";

type ThreadToolItem = { type: "tool"; id: string; messages: Message[]; turnId?: string };

export type ThreadDisplayItem =
  | { type: "message"; id: string; message: Message; turnId?: string }
  | ThreadToolItem
  | {
      type: "tool_cluster";
      id: string;
      tools: ThreadToolItem[];
      turnId?: string;
    };

const INLINE_TOOL_SUMMARY_THRESHOLD = 2;
const MAX_DELTA_MERGE_GAP_MS = 2_000;

function readText(payload: unknown): string {
  if (payload && typeof payload === "object" && "text" in payload) {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  if (typeof payload === "string") return payload;
  return "";
}

function readStringField(
  payload: Record<string, unknown>,
  key: string
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOutputId(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "outputId" in payload) {
    const outputId = (payload as { outputId?: unknown }).outputId;
    if (typeof outputId === "string" && outputId) return outputId;
  }
  return undefined;
}

function readObjectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function readPayloadMetadata(payload: unknown): Record<string, unknown> {
  const object = readObjectPayload(payload);
  return readObjectPayload(object.metadata);
}

function isInternalStatus(message: Message): boolean {
  if (message.kind !== "status") {
    return false;
  }

  const payload = readObjectPayload(message.payload);
  const metadata = readPayloadMetadata(message.payload);
  const itemType = readStringField(metadata, "itemType")?.toLowerCase();
  if (itemType === "reasoning") {
    return true;
  }

  const text = readText(message.payload).trim().toLowerCase();
  const title = readStringField(payload, "title")?.trim().toLowerCase();
  if (/^status:\s*(in\s*progress|inprogress|completed|failed|interrupted)$/.test(text)) {
    return true;
  }

  return (
    text === "planning started." ||
    text === "planning updated." ||
    title === "plan started" ||
    title === "plan updated"
  );
}

function isToolMessage(message: Message): boolean {
  return message.kind === "tool_call" || message.kind === "tool_output";
}

function readTurnId(message: Message): string | undefined {
  const payload = readObjectPayload(message.payload);
  const metadata = readPayloadMetadata(message.payload);
  const metadataTurnId = readStringField(metadata, "turnId");
  if (metadataTurnId) {
    return metadataTurnId;
  }

  const outputId = readStringField(payload, "outputId");
  if (outputId?.includes(":")) {
    return outputId.split(":")[0];
  }

  const toolUseId = readStringField(payload, "toolUseId");
  const toolUseMatch = toolUseId?.match(/^item:([^:]+):/);
  return toolUseMatch?.[1];
}

function readToolGroupKey(message: Message): string | undefined {
  const payload = readObjectPayload(message.payload);
  const metadata = readPayloadMetadata(message.payload);
  return readStringField(payload, "toolUseId") ?? readStringField(metadata, "groupId");
}

export function buildThreadDisplayItems(messages: Message[]): ThreadDisplayItem[] {
  const items: ThreadDisplayItem[] = [];
  const toolGroups = new Map<string, ThreadToolItem>();

  for (const message of messages) {
    if (isInternalStatus(message)) {
      continue;
    }

    if (!isToolMessage(message)) {
      items.push({
        type: "message",
        id: message.id,
        message,
        turnId: readTurnId(message)
      });
      continue;
    }

    const groupKey = readToolGroupKey(message) ?? message.id;
    let group = toolGroups.get(groupKey);
    if (!group) {
      group = {
        type: "tool",
        id: groupKey,
        messages: [],
        turnId: readTurnId(message)
      };
      toolGroups.set(groupKey, group);
      items.push(group);
    }

    group.messages.push(message);
  }

  return summarizeInlineToolRuns(items);
}

function isAgentChatDisplayItem(
  item: ThreadDisplayItem | undefined
): item is Extract<ThreadDisplayItem, { type: "message" }> {
  return (
    item?.type === "message" &&
    item.message.kind === "chat" &&
    item.message.sender.type === "agent"
  );
}

function summarizeInlineToolRuns(items: ThreadDisplayItem[]): ThreadDisplayItem[] {
  const collapsed: ThreadDisplayItem[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) {
      continue;
    }

    if (item.type !== "tool") {
      collapsed.push(item);
      continue;
    }

    const tools: ThreadToolItem[] = [];
    let scanIndex = index;
    while (scanIndex < items.length) {
      const candidate = items[scanIndex];
      if (!candidate || candidate.type !== "tool") {
        break;
      }
      tools.push(candidate);
      scanIndex += 1;
    }

    const previous = collapsed.at(-1);
    const next = items[scanIndex];
    const isInlineRun =
      tools.length > INLINE_TOOL_SUMMARY_THRESHOLD ||
      (isAgentChatDisplayItem(previous) && isAgentChatDisplayItem(next));
    if (
      isInlineRun &&
      (isAgentChatDisplayItem(previous) || isAgentChatDisplayItem(next))
    ) {
      collapsed.push({
        type: "tool_cluster",
        id: `tool-cluster:${tools[0]?.id ?? "start"}:${tools.at(-1)?.id ?? "end"}`,
        tools,
        turnId: tools[0]?.turnId
      });
    } else {
      collapsed.push(...tools);
    }

    index = scanIndex - 1;
  }

  return collapsed;
}

function isCjkCharacter(value: string): boolean {
  const code = value.codePointAt(0);
  return Boolean(
    code &&
      ((code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xf900 && code <= 0xfaff))
  );
}

function endsSentence(value: string): boolean {
  const trimmed = value.trimEnd().replace(/[)"'`」』】）\]]+$/g, "");
  return /[.!?。！？…]$/.test(trimmed);
}

function startsWithContinuationPunctuation(value: string): boolean {
  return /^[,.;:!?，。！？；：、)"'`」』】）\]]/.test(value.trimStart());
}

function endsWithContinuationPunctuation(value: string): boolean {
  return /[,;:，；：、([{（【「『]$/.test(value.trimEnd());
}

function shouldJoinDirectly(previousText: string, nextText: string): boolean {
  if (!previousText || !nextText) return true;
  if (/\s$/.test(previousText) || /^\s/.test(nextText)) return true;
  if (startsWithContinuationPunctuation(nextText)) return true;
  if (endsWithContinuationPunctuation(previousText)) return true;

  const previousLast = previousText.trimEnd().at(-1) ?? "";
  const nextFirst = nextText.trimStart().at(0) ?? "";
  if (!previousLast || !nextFirst) return true;
  if (endsSentence(previousText)) return false;

  if (isCjkCharacter(previousLast) && isCjkCharacter(nextFirst)) return true;
  if (
    /[\p{L}\p{N}_/$@.-]/u.test(previousLast) &&
    /[\p{L}\p{N}_/$@.-]/u.test(nextFirst)
  ) {
    return true;
  }

  return false;
}

function joinAgentChatText(
  previousText: string,
  nextText: string,
  previousOutputId?: string,
  nextOutputId?: string
): string {
  if (previousOutputId && nextOutputId) {
    if (previousOutputId === nextOutputId) {
      return `${previousText}${nextText}`;
    }
    return `${previousText.trimEnd()}\n\n${nextText.trimStart()}`;
  }

  if (shouldJoinDirectly(previousText, nextText)) {
    return `${previousText}${nextText}`;
  }
  return `${previousText.trimEnd()}\n\n${nextText.trimStart()}`;
}

function canMergeAgentChat(previous: Message | undefined, next: Message): boolean {
  if (
    !previous ||
    previous.kind !== "chat" ||
    previous.sender.type !== "agent" ||
    next.kind !== "chat" ||
    next.sender.type !== "agent" ||
    previous.sender.agentId !== next.sender.agentId
  ) {
    return false;
  }

  const previousOutputId = readOutputId(previous.payload);
  const nextOutputId = readOutputId(next.payload);
  if (previousOutputId || nextOutputId) {
    return previousOutputId === nextOutputId;
  }

  const previousTime = Date.parse(previous.createdAt);
  const nextTime = Date.parse(next.createdAt);
  if (
    Number.isFinite(previousTime) &&
    Number.isFinite(nextTime) &&
    endsSentence(readText(previous.payload)) &&
    nextTime - previousTime > MAX_DELTA_MERGE_GAP_MS
  ) {
    return false;
  }

  return true;
}

export function mergeAdjacentAgentChatMessages(messages: Message[]): Message[] {
  const merged: Message[] = [];

  for (const message of messages) {
    const previous = merged.at(-1);
    if (!canMergeAgentChat(previous, message) || !previous) {
      merged.push(message);
      continue;
    }

    merged[merged.length - 1] = {
      ...previous,
      payload: {
        ...readObjectPayload(previous.payload),
        outputId: readOutputId(message.payload) ?? readOutputId(previous.payload),
        text: joinAgentChatText(
          readText(previous.payload),
          readText(message.payload),
          readOutputId(previous.payload),
          readOutputId(message.payload)
        )
      },
      createdAt: message.createdAt
    };
  }

  return merged;
}

export function upsertThreadMessage(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index === -1) {
    return [...messages, message];
  }

  return messages.map((item, itemIndex) => (itemIndex === index ? message : item));
}
