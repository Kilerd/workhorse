// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import * as threadHooks from "@/hooks/useThreads";
import { getThreadDraftStorageKey } from "@/lib/thread-draft";

import { ThreadView } from "./ThreadView";

vi.mock("@/hooks/useThreads", () => ({
  useThreadMessages: vi.fn(),
  usePostThreadMessage: vi.fn()
}));

const useThreadMessagesMock = vi.mocked(threadHooks.useThreadMessages);
const usePostThreadMessageMock = vi.mocked(threadHooks.usePostThreadMessage);
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("ThreadView draft persistence", () => {
  let container: HTMLDivElement;
  let root: Root;
  const mutateAsync = vi.fn();

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();

    mutateAsync.mockReset().mockResolvedValue(undefined);
    useThreadMessagesMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null
    } as unknown as ReturnType<typeof threadHooks.useThreadMessages>);
    usePostThreadMessageMock.mockReturnValue({
      mutateAsync,
      isPending: false
    } as unknown as ReturnType<typeof threadHooks.usePostThreadMessage>);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("restores drafts after remounting and keeps them isolated per thread", async () => {
    await renderThread("thread-1");
    await setDraftValue("Draft for thread 1");

    expect(window.localStorage.getItem(getThreadDraftStorageKey("thread-1"))).toBe(
      JSON.stringify("Draft for thread 1")
    );

    await remountThread("thread-1");
    expect(getTextarea().value).toBe("Draft for thread 1");

    await renderThread("thread-2");
    expect(getTextarea().value).toBe("");

    await setDraftValue("Draft for thread 2");

    expect(window.localStorage.getItem(getThreadDraftStorageKey("thread-1"))).toBe(
      JSON.stringify("Draft for thread 1")
    );
    expect(window.localStorage.getItem(getThreadDraftStorageKey("thread-2"))).toBe(
      JSON.stringify("Draft for thread 2")
    );

    await renderThread("thread-1");
    expect(getTextarea().value).toBe("Draft for thread 1");
  });

  it("persists the latest draft even when leaving immediately after typing", async () => {
    await renderThread("thread-1");

    act(() => {
      setDraftValueSync("Last-second draft");
      root.unmount();
    });

    root = createRoot(container);
    await renderThread("thread-1");

    expect(window.localStorage.getItem(getThreadDraftStorageKey("thread-1"))).toBe(
      JSON.stringify("Last-second draft")
    );
    expect(getTextarea().value).toBe("Last-second draft");
  });

  it("keeps the composer usable when localStorage writes fail", async () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });

    try {
      await renderThread("thread-1");
      await setDraftValue("Draft without storage");

      expect(getTextarea().value).toBe("Draft without storage");
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it("clears the current thread draft after a successful send", async () => {
    await renderThread("thread-1");
    await setDraftValue("  Keep the trim behavior  ");

    await act(async () => {
      getSendButton().click();
    });

    expect(mutateAsync).toHaveBeenCalledWith({
      content: "Keep the trim behavior",
      kind: "chat"
    });
    expect(window.localStorage.getItem(getThreadDraftStorageKey("thread-1"))).toBeNull();
    expect(getTextarea().value).toBe("");
  });

  it("keeps the send flow working when localStorage cleanup fails", async () => {
    await renderThread("thread-1");
    await setDraftValue("Send despite cleanup failure");

    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new DOMException("SecurityError");
      });

    try {
      await act(async () => {
        getSendButton().click();
      });

      expect(mutateAsync).toHaveBeenCalledWith({
        content: "Send despite cleanup failure",
        kind: "chat"
      });
      expect(getTextarea().value).toBe("");
    } finally {
      removeItemSpy.mockRestore();
    }
  });

  async function renderThread(threadId: string) {
    await act(async () => {
      root.render(<ThreadView threadId={threadId} />);
    });
  }

  async function remountThread(threadId: string) {
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderThread(threadId);
  }

  async function setDraftValue(value: string) {
    await act(async () => {
      setDraftValueSync(value);
    });
  }

  function setDraftValueSync(value: string) {
    const textarea = getTextarea();
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function getTextarea() {
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    return textarea as HTMLTextAreaElement;
  }

  function getSendButton() {
    const button = container.querySelector('button[type="submit"]');
    expect(button).not.toBeNull();
    return button as HTMLButtonElement;
  }
});
