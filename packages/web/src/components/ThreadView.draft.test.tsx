// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildThreadDraftStorageKey } from "@/lib/thread-drafts";

import { ThreadView } from "./ThreadView";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "value"
)?.set;

const mockUseThreadMessages = vi.fn();
const mockUsePostThreadMessage = vi.fn();
const mockMutateAsync = vi.fn();

vi.mock("@/hooks/useThreads", () => ({
  useThreadMessages: (...args: unknown[]) => mockUseThreadMessages(...args),
  usePostThreadMessage: (...args: unknown[]) => mockUsePostThreadMessage(...args)
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn()
}));

async function renderThreadView(root: Root, threadId: string) {
  await act(async () => {
    root.render(<ThreadView threadId={threadId} />);
  });
}

async function changeTextareaValue(container: HTMLDivElement, value: string) {
  const textarea = container.querySelector("textarea");
  if (!textarea) {
    throw new Error("Textarea not found");
  }
  if (!nativeTextareaValueSetter) {
    throw new Error("Textarea value setter not found");
  }

  await act(async () => {
    nativeTextareaValueSetter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  });

  return textarea;
}

async function submitComposer(container: HTMLDivElement) {
  const form = container.querySelector("form");
  if (!form) {
    throw new Error("Composer form not found");
  }

  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("ThreadView draft persistence", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockUseThreadMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null
    });
    mockUsePostThreadMessage.mockReturnValue({
      isPending: false,
      mutateAsync: mockMutateAsync
    });
    mockMutateAsync.mockReset();
    localStorage.clear();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("restores the saved draft for the active thread and keeps threads isolated", async () => {
    localStorage.setItem(buildThreadDraftStorageKey("thread-a"), "Saved A");
    localStorage.setItem(buildThreadDraftStorageKey("thread-b"), "Saved B");

    await renderThreadView(root, "thread-a");

    const textareaA = container.querySelector("textarea");
    expect(textareaA).not.toBeNull();
    expect(textareaA?.value).toBe("Saved A");

    await changeTextareaValue(container, "Edited A");
    expect(localStorage.getItem(buildThreadDraftStorageKey("thread-a"))).toBe("Edited A");
    expect(localStorage.getItem(buildThreadDraftStorageKey("thread-b"))).toBe("Saved B");

    await renderThreadView(root, "thread-b");

    const textareaB = container.querySelector("textarea");
    expect(textareaB?.value).toBe("Saved B");

    await changeTextareaValue(container, "Edited B");
    expect(localStorage.getItem(buildThreadDraftStorageKey("thread-a"))).toBe("Edited A");
    expect(localStorage.getItem(buildThreadDraftStorageKey("thread-b"))).toBe("Edited B");

    await renderThreadView(root, "thread-a");
    expect(container.querySelector("textarea")?.value).toBe("Edited A");
  });

  it("clears only the sent thread draft after a successful send", async () => {
    mockMutateAsync.mockResolvedValue({
      id: "message-1",
      threadId: "thread-a",
      kind: "chat",
      payload: { text: "Pending message" },
      sender: { type: "user" },
      createdAt: "2026-05-02T00:00:00.000Z"
    });
    localStorage.setItem(buildThreadDraftStorageKey("thread-a"), "Pending message");
    localStorage.setItem(buildThreadDraftStorageKey("thread-b"), "Keep me");

    await renderThreadView(root, "thread-a");
    await submitComposer(container);

    expect(mockMutateAsync).toHaveBeenCalledWith({
      content: "Pending message",
      kind: "chat"
    });
    expect(localStorage.getItem(buildThreadDraftStorageKey("thread-a"))).toBeNull();
    expect(localStorage.getItem(buildThreadDraftStorageKey("thread-b"))).toBe("Keep me");
    expect(container.querySelector("textarea")?.value).toBe("");
  });
});
