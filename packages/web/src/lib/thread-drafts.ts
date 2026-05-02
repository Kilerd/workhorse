const THREAD_DRAFT_STORAGE_PREFIX = "workhorse:thread-draft";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function resolveStorage(storage?: DraftStorage | null): DraftStorage | null {
  return storage ?? globalThis.localStorage ?? null;
}

export function buildThreadDraftStorageKey(threadId: string): string {
  return `${THREAD_DRAFT_STORAGE_PREFIX}:${threadId}`;
}

export function loadThreadDraft(
  threadId: string,
  storage?: DraftStorage | null
): string {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) {
    return "";
  }

  try {
    return resolvedStorage.getItem(buildThreadDraftStorageKey(threadId)) ?? "";
  } catch {
    return "";
  }
}

export function persistThreadDraft(
  threadId: string,
  draft: string,
  storage?: DraftStorage | null
): void {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) {
    return;
  }

  try {
    if (draft.length === 0) {
      resolvedStorage.removeItem(buildThreadDraftStorageKey(threadId));
      return;
    }

    resolvedStorage.setItem(buildThreadDraftStorageKey(threadId), draft);
  } catch {
    // Ignore storage failures so the composer keeps working.
  }
}

export function clearThreadDraft(
  threadId: string,
  storage?: DraftStorage | null
): void {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) {
    return;
  }

  try {
    resolvedStorage.removeItem(buildThreadDraftStorageKey(threadId));
  } catch {
    // Ignore storage failures so the composer keeps working.
  }
}
