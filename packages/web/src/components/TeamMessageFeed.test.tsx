import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TeamFeedMessage } from "./TeamMessageFeed";
import { TeamMessageFeed } from "./TeamMessageFeed";

function createMessage(overrides: Partial<TeamFeedMessage>): TeamFeedMessage {
  return {
    id: "message-1",
    taskId: "task-1",
    agentName: "Coordinator",
    senderType: "agent",
    messageType: "context",
    content: "Hello",
    createdAt: "2026-04-23T00:00:00.000Z",
    ...overrides
  };
}

describe("TeamMessageFeed", () => {
  it("renders agent context messages as markdown without a bubble container", () => {
    const markup = renderToStaticMarkup(
      <TeamMessageFeed
        messages={[
          createMessage({
            content: "## Title\n\n- first\n- second\n\n`inline`"
          })
        ]}
      />
    );

    expect(markup).toContain("<h4");
    expect(markup).toContain("<ul");
    expect(markup).toContain("<code");
    expect(markup).not.toContain("rounded-[var(--radius)] border border-border bg-[var(--panel)] px-4 py-3");
  });

  it("renders human context messages as right-aligned bubbles", () => {
    const markup = renderToStaticMarkup(
      <TeamMessageFeed
        messages={[
          createMessage({
            id: "human-1",
            senderType: "human",
            agentName: "User",
            content: "Need help with this bug."
          })
        ]}
      />
    );

    expect(markup).toContain("justify-items-end");
    expect(markup).toContain("rounded-[var(--radius)] border border-border bg-[var(--panel)] px-4 py-3");
    expect(markup).toContain("Need help with this bug.");
  });
});
