import type { Message } from "@workhorse/contracts";

export type ThreadDisplayItem =
  | { type: "message"; id: string; message: Message; turnId?: string }
  | { type: "tool"; id: string; messages: Message[]; turnId?: string };

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
  const toolGroups = new Map<string, Extract<ThreadDisplayItem, { type: "tool" }>>();

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

  return interleaveFollowingTurnTools(items);
}

function canSplitAroundTools(
  item: ThreadDisplayItem
): item is Extract<ThreadDisplayItem, { type: "message" }> {
  return (
    item.type === "message" &&
    item.message.kind === "chat" &&
    item.message.sender.type === "agent" &&
    Boolean(item.turnId)
  );
}

function splitIntroText(text: string): { lead: string; rest: string } | undefined {
  const paragraphBreak = /\n{2,}/.exec(text);
  if (paragraphBreak) {
    const lead = text.slice(0, paragraphBreak.index).trimEnd();
    const rest = text.slice(paragraphBreak.index + paragraphBreak[0].length).trimStart();
    return lead && rest ? { lead, rest } : undefined;
  }

  const sentenceEndPattern = /[.!?。！？…]+[)"'`」』】）\]]*/gu;
  for (const match of text.matchAll(sentenceEndPattern)) {
    const splitIndex = match.index + match[0].length;
    const lead = text.slice(0, splitIndex).trimEnd();
    const rest = text.slice(splitIndex).trimStart();
    if (lead && rest) {
      return { lead, rest };
    }
  }

  return undefined;
}

function cloneMessageWithText(message: Message, id: string, text: string): Message {
  return {
    ...message,
    id,
    payload: {
      ...readObjectPayload(message.payload),
      text
    }
  };
}

function interleaveFollowingTurnTools(items: ThreadDisplayItem[]): ThreadDisplayItem[] {
  const interleaved: ThreadDisplayItem[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const rawItem = items[index];
    if (!rawItem) {
      continue;
    }
    const item: ThreadDisplayItem = rawItem;

    if (!canSplitAroundTools(item)) {
      interleaved.push(item);
      continue;
    }

    const followingTools: Extract<ThreadDisplayItem, { type: "tool" }>[] = [];
    let scanIndex = index + 1;
    while (scanIndex < items.length) {
      const rawCandidate = items[scanIndex];
      if (!rawCandidate) {
        break;
      }
      if (rawCandidate.type !== "tool" || rawCandidate.turnId !== item.turnId) {
        break;
      }

      const candidate: Extract<ThreadDisplayItem, { type: "tool" }> = rawCandidate;
      followingTools.push(candidate);
      scanIndex += 1;
    }

    const split = followingTools.length
      ? splitIntroText(readText(item.message.payload))
      : undefined;
    if (!split) {
      interleaved.push(item);
      continue;
    }

    interleaved.push({
      ...item,
      id: `${item.id}:lead`,
      message: cloneMessageWithText(item.message, `${item.message.id}:lead`, split.lead)
    });
    interleaved.push(...followingTools);
    interleaved.push({
      ...item,
      id: `${item.id}:rest`,
      message: cloneMessageWithText(item.message, `${item.message.id}:rest`, split.rest)
    });
    index = scanIndex - 1;
  }

  return interleaved;
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
