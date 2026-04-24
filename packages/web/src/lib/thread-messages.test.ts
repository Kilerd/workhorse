import { describe, expect, it } from "vitest";
import type { Message } from "@workhorse/contracts";

import {
  buildThreadDisplayItems,
  mergeAdjacentAgentChatMessages,
  upsertThreadMessage
} from "./thread-messages";

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: "message-1",
    threadId: "thread-1",
    sender: { type: "user" },
    kind: "chat",
    payload: { text: "" },
    createdAt: "2026-04-24T09:00:00.000Z",
    ...overrides
  };
}

describe("mergeAdjacentAgentChatMessages", () => {
  it("merges consecutive agent chat chunks into a single display message", () => {
    const merged = mergeAdjacentAgentChatMessages([
      makeMessage({
        id: "agent-1",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "thread " }
      }),
      makeMessage({
        id: "agent-2",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "里的" },
        createdAt: "2026-04-24T09:00:01.000Z"
      }),
      makeMessage({
        id: "agent-3",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "聊天消息" },
        createdAt: "2026-04-24T09:00:02.000Z"
      })
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("agent-1");
    expect(merged[0]?.payload).toEqual({ text: "thread 里的聊天消息" });
    expect(merged[0]?.createdAt).toBe("2026-04-24T09:00:02.000Z");
  });

  it("does not merge across non-agent rows or different agents", () => {
    const merged = mergeAdjacentAgentChatMessages([
      makeMessage({
        id: "agent-1",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "hello" }
      }),
      makeMessage({
        id: "status-1",
        sender: { type: "agent", agentId: "agent-a" },
        kind: "status",
        payload: { text: "working" }
      }),
      makeMessage({
        id: "agent-2",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: " world" }
      }),
      makeMessage({
        id: "agent-3",
        sender: { type: "agent", agentId: "agent-b" },
        payload: { text: "!" }
      })
    ]);

    expect(merged.map((message) => message.id)).toEqual([
      "agent-1",
      "status-1",
      "agent-2",
      "agent-3"
    ]);
  });

  it("keeps split agent text contiguous when a message boundary cuts through a word", () => {
    const merged = mergeAdjacentAgentChatMessages([
      makeMessage({
        id: "agent-1",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "现在可直接改。思路很小：复用现有 `lib/markdown.tsx`，只替" },
        createdAt: "2026-04-24T10:00:00.000Z"
      }),
      makeMessage({
        id: "agent-2",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "换 chat message 的内容节点；再加一个测试。" },
        createdAt: "2026-04-24T10:00:10.000Z"
      })
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.payload).toEqual({
      text: "现在可直接改。思路很小：复用现有 `lib/markdown.tsx`，只替换 chat message 的内容节点；再加一个测试。"
    });
  });

  it("separates complete adjacent agent updates as paragraphs in one display block", () => {
    const merged = mergeAdjacentAgentChatMessages([
      makeMessage({
        id: "agent-1",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "已验证 `npm run test`。" },
        createdAt: "2026-04-24T10:00:00.000Z"
      }),
      makeMessage({
        id: "agent-2",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "我先查一下渲染链路。" },
        createdAt: "2026-04-24T10:00:10.000Z"
      })
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.payload).toEqual({
      text: "已验证 `npm run test`。\n\n我先查一下渲染链路。"
    });
  });

  it("attaches punctuation-only chunks to their surrounding sentence", () => {
    const merged = mergeAdjacentAgentChatMessages([
      makeMessage({
        id: "agent-1",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "我先把这条需求记成一个明确的产品改动" }
      }),
      makeMessage({
        id: "agent-2",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "：" }
      }),
      makeMessage({
        id: "agent-3",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "\n\nthread 里的 agent 返回内容需要按 Markdown 渲染显示" }
      }),
      makeMessage({
        id: "agent-4",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "。" }
      }),
      makeMessage({
        id: "agent-5",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "接下来我会先看一下当前 workspace 状态" }
      }),
      makeMessage({
        id: "agent-6",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "，" }
      }),
      makeMessage({
        id: "agent-7",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "避免重复创建任务" }
      })
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.payload).toEqual({
      text:
        "我先把这条需求记成一个明确的产品改动：\n\n" +
        "thread 里的 agent 返回内容需要按 Markdown 渲染显示。\n\n" +
        "接下来我会先看一下当前 workspace 状态，避免重复创建任务"
    });
  });

  it("uses output ids as the primary assistant text grouping key", () => {
    const merged = mergeAdjacentAgentChatMessages([
      makeMessage({
        id: "agent-1",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "产品改动", outputId: "turn-1:item-1" }
      }),
      makeMessage({
        id: "agent-2",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "：", outputId: "turn-1:item-1" }
      }),
      makeMessage({
        id: "agent-3",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "先看 workspace", outputId: "turn-1:item-2" }
      }),
      makeMessage({
        id: "agent-4",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "，再定位代码", outputId: "turn-1:item-2" }
      })
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]?.payload).toEqual({
      text: "产品改动：",
      outputId: "turn-1:item-1"
    });
    expect(merged[1]?.payload).toEqual({
      text: "先看 workspace，再定位代码",
      outputId: "turn-1:item-2"
    });
  });
});

describe("upsertThreadMessage", () => {
  it("replaces an existing thread message by id", () => {
    const current = [
      makeMessage({ id: "m-1", payload: { text: "hello" } }),
      makeMessage({ id: "m-2", payload: { text: "world" } })
    ];

    const next = upsertThreadMessage(
      current,
      makeMessage({ id: "m-2", payload: { text: "world!" } })
    );

    expect(next).toEqual([
      makeMessage({ id: "m-1", payload: { text: "hello" } }),
      makeMessage({ id: "m-2", payload: { text: "world!" } })
    ]);
  });

  it("appends a new thread message when the id is not present", () => {
    const next = upsertThreadMessage(
      [makeMessage({ id: "m-1", payload: { text: "hello" } })],
      makeMessage({ id: "m-2", payload: { text: "world" } })
    );

    expect(next.map((message) => message.id)).toEqual(["m-1", "m-2"]);
  });
});

describe("buildThreadDisplayItems", () => {
  it("hides internal planning status rows", () => {
    const items = buildThreadDisplayItems([
      makeMessage({
        id: "status-1",
        sender: { type: "agent", agentId: "agent-a" },
        kind: "status",
        payload: {
          text: "Planning started.",
          metadata: { itemType: "reasoning" }
        }
      }),
      makeMessage({
        id: "chat-1",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "Visible reply" }
      })
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "message",
      id: "chat-1"
    });
  });

  it("hides internal lifecycle status rows", () => {
    const items = buildThreadDisplayItems([
      makeMessage({
        id: "status-started",
        sender: { type: "agent", agentId: "agent-a" },
        kind: "status",
        payload: {
          text: "status: inProgress",
          metadata: { itemType: "fileChange", phase: "started" }
        }
      }),
      makeMessage({
        id: "status-completed",
        sender: { type: "agent", agentId: "agent-a" },
        kind: "status",
        payload: {
          text: "status: completed",
          metadata: { itemType: "fileChange", phase: "completed" }
        }
      }),
      makeMessage({
        id: "chat-1",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "Visible reply" }
      })
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "message",
      id: "chat-1"
    });
  });

  it("groups tool lifecycle rows without moving them ahead of earlier text", () => {
    const turnId = "turn-1";
    const groupId = `item:${turnId}:call-1`;
    const items = buildThreadDisplayItems([
      makeMessage({
        id: "chat-1",
        sender: { type: "agent", agentId: "agent-a" },
        payload: { text: "I checked it.", outputId: `${turnId}:msg-1` }
      }),
      makeMessage({
        id: "tool-start",
        sender: { type: "agent", agentId: "agent-a" },
        kind: "tool_call",
        payload: {
          text: "git status --short",
          toolUseId: groupId,
          metadata: { turnId, groupId, phase: "started" }
        }
      }),
      makeMessage({
        id: "tool-complete",
        sender: { type: "agent", agentId: "agent-a" },
        kind: "tool_call",
        payload: {
          text: "git status --short",
          toolUseId: groupId,
          metadata: { turnId, groupId, phase: "completed" }
        }
      })
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "message",
      id: "chat-1"
    });
    expect(items[1]).toMatchObject({
      type: "tool",
      id: groupId
    });
    expect(items[1]?.type === "tool" ? items[1].messages.map((m) => m.id) : []).toEqual([
      "tool-start",
      "tool-complete"
    ]);
  });

  it("keeps same-turn tools between an intro paragraph and the remaining agent text", () => {
    const turnId = "turn-1";
    const groupId = `item:${turnId}:call-1`;
    const items = buildThreadDisplayItems([
      makeMessage({
        id: "chat-1",
        sender: { type: "agent", agentId: "agent-a" },
        payload: {
          text: "我先看一下当前状态。结果看起来是 tool 顺序的问题。",
          outputId: `${turnId}:msg-1`
        }
      }),
      makeMessage({
        id: "tool-start",
        sender: { type: "agent", agentId: "agent-a" },
        kind: "tool_call",
        payload: {
          text: "git status --short",
          toolUseId: groupId,
          metadata: { turnId, groupId, phase: "started" }
        }
      }),
      makeMessage({
        id: "tool-complete",
        sender: { type: "agent", agentId: "agent-a" },
        kind: "tool_call",
        payload: {
          text: "git status --short",
          toolUseId: groupId,
          metadata: { turnId, groupId, phase: "completed" }
        }
      })
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "tool", "message"]);
    expect(items[0]).toMatchObject({
      type: "message",
      id: "chat-1:lead",
      message: { payload: { text: "我先看一下当前状态。" } }
    });
    expect(items[1]).toMatchObject({
      type: "tool",
      id: groupId
    });
    expect(items[2]).toMatchObject({
      type: "message",
      id: "chat-1:rest",
      message: { payload: { text: "结果看起来是 tool 顺序的问题。" } }
    });
  });
});
