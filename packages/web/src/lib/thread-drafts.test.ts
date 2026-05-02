import { describe, expect, it } from "vitest";

import {
  buildThreadDraftStorageKey,
  clearThreadDraft,
  loadThreadDraft,
  persistThreadDraft
} from "./thread-drafts";

function createStorage() {
  const store = new Map<string, string>();

  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    }
  };
}

describe("thread-drafts", () => {
  it("builds a unique storage key per thread", () => {
    expect(buildThreadDraftStorageKey("thread-a")).toBe(
      "workhorse:thread-draft:thread-a"
    );
    expect(buildThreadDraftStorageKey("thread-b")).toBe(
      "workhorse:thread-draft:thread-b"
    );
  });

  it("persists and restores a draft for the matching thread only", () => {
    const storage = createStorage();

    persistThreadDraft("thread-a", "Need to retry the run", storage);
    persistThreadDraft("thread-b", "Second draft", storage);

    expect(loadThreadDraft("thread-a", storage)).toBe("Need to retry the run");
    expect(loadThreadDraft("thread-b", storage)).toBe("Second draft");
    expect(loadThreadDraft("missing-thread", storage)).toBe("");
  });

  it("clears only the targeted thread draft", () => {
    const storage = createStorage();

    persistThreadDraft("thread-a", "Keep working", storage);
    persistThreadDraft("thread-b", "Leave me alone", storage);

    clearThreadDraft("thread-a", storage);

    expect(loadThreadDraft("thread-a", storage)).toBe("");
    expect(loadThreadDraft("thread-b", storage)).toBe("Leave me alone");
  });

  it("removes the stored draft when the composer becomes empty", () => {
    const storage = createStorage();

    persistThreadDraft("thread-a", "Draft", storage);
    persistThreadDraft("thread-a", "", storage);

    expect(loadThreadDraft("thread-a", storage)).toBe("");
  });
});
