import type { Message } from "@workhorse/contracts";

function readText(payload: unknown): string {
  if (payload && typeof payload === "object" && "text" in payload) {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  if (typeof payload === "string") return payload;
  return "";
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
  return Boolean(
    previous &&
      previous.kind === "chat" &&
      previous.sender.type === "agent" &&
      next.kind === "chat" &&
      next.sender.type === "agent" &&
      previous.sender.agentId === next.sender.agentId
  );
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
