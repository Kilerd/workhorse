import {
  readStoredValue,
  removeStoredValue,
  writeStoredValue
} from "@/lib/persist";

const THREAD_DRAFT_STORAGE_KEY_PREFIX = "workhorse.threadDraft";

export function getThreadDraftStorageKey(threadId: string): string {
  return `${THREAD_DRAFT_STORAGE_KEY_PREFIX}.${threadId}`;
}

export function readThreadDraft(threadId: string): string {
  const stored = readStoredValue<string | null>(
    getThreadDraftStorageKey(threadId),
    null
  );

  return typeof stored === "string" ? stored : "";
}

export function writeThreadDraft(threadId: string, draft: string): void {
  if (draft.length === 0) {
    clearThreadDraft(threadId);
    return;
  }

  writeStoredValue(getThreadDraftStorageKey(threadId), draft);
}

export function clearThreadDraft(threadId: string): void {
  removeStoredValue(getThreadDraftStorageKey(threadId));
}
