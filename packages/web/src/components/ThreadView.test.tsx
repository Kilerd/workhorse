import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "@workhorse/contracts";

import { ChatRow, ToolEventRow } from "./ThreadView";

function makeChatMessage(overrides: Partial<Message>): Message {
  return {
    id: "message-1",
    threadId: "thread-1",
    sender: { type: "agent", agentId: "agent-a" },
    kind: "chat",
    payload: { text: "Agent reply" },
    createdAt: "2026-04-24T09:00:00.000Z",
    ...overrides
  };
}

describe("ChatRow", () => {
  it("renders agent chat as bare markdown without technical metadata", () => {
    const html = renderToStaticMarkup(
      <ChatRow
        message={makeChatMessage({
          sender: {
            type: "agent",
            agentId: "b93d17f1-5dca-438b-bf6b-2429708ba8b5"
          },
          payload: { text: "**Done**\n\n- built" }
        })}
      />
    );

    expect(html).toContain("<strong");
    expect(html).toContain("<ul");
    expect(html).not.toContain("b93d17f1-5dca-438b-bf6b-2429708ba8b5");
    expect(html).not.toContain(">chat<");
    expect(html).not.toContain("ago");
    expect(html).not.toContain("rounded-lg border bg-[var(--panel)]");
  });

  it("keeps user chat in a compact input bubble without metadata", () => {
    const html = renderToStaticMarkup(
      <ChatRow
        message={makeChatMessage({
          sender: { type: "user" },
          payload: { text: "Please fix the thread view." }
        })}
      />
    );

    expect(html).toContain("rounded-lg border bg-[var(--panel)]");
    expect(html).toContain("Please fix the thread view.");
    expect(html).not.toContain(">you<");
    expect(html).not.toContain(">chat<");
  });
});

describe("ToolEventRow", () => {
  it("renders tool use messages without exposing the agent id", () => {
    const html = renderToStaticMarkup(
      <ToolEventRow
        message={makeChatMessage({
          sender: {
            type: "agent",
            agentId: "b93d17f1-5dca-438b-bf6b-2429708ba8b5"
          },
          kind: "tool_call",
          payload: {
            toolUseId: "tu-1",
            name: "get_workspace_state",
            input: {},
            status: "started"
          }
        })}
      />
    );

    expect(html).toContain("Get Workspace State");
    expect(html).not.toContain("b93d17f1-5dca-438b-bf6b-2429708ba8b5");
  });
});
