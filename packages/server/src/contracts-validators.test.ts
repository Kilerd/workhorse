import { describe, expect, it } from "vitest";

import { validateMessage } from "@workhorse/contracts";

const basePayload = { anything: "goes" };

const kinds = [
  "chat",
  "status",
  "artifact",
  "plan_draft",
  "plan_decision",
  "system_event"
] as const;

describe("validateMessage (Agent-driven board, Spec 02)", () => {
  for (const kind of kinds) {
    it(`accepts a valid Message of kind "${kind}" (user sender)`, () => {
      const result = validateMessage({
        id: "m_1",
        threadId: "t_1",
        sender: { type: "user" },
        kind,
        payload: basePayload,
        createdAt: "2026-04-23T00:00:00.000Z"
      });
      expect(result.success).toBe(true);
    });
  }

  it("accepts an agent-sender message with consumedByRunId", () => {
    const result = validateMessage({
      id: "m_2",
      threadId: "t_1",
      sender: { type: "agent", agentId: "a_1" },
      kind: "chat",
      payload: basePayload,
      consumedByRunId: "r_42",
      createdAt: "2026-04-23T00:00:00.000Z"
    });
    expect(result.success).toBe(true);
  });

  it("accepts a system-sender message", () => {
    const result = validateMessage({
      id: "m_3",
      threadId: "t_1",
      sender: { type: "system" },
      kind: "system_event",
      payload: basePayload,
      createdAt: "2026-04-23T00:00:00.000Z"
    });
    expect(result.success).toBe(true);
  });

  it("rejects a message with an unknown kind", () => {
    const result = validateMessage({
      id: "m_4",
      threadId: "t_1",
      sender: { type: "user" },
      kind: "not_a_real_kind",
      payload: basePayload,
      createdAt: "2026-04-23T00:00:00.000Z"
    });
    expect(result.success).toBe(false);
  });

  it("rejects an agent sender missing agentId", () => {
    const result = validateMessage({
      id: "m_5",
      threadId: "t_1",
      sender: { type: "agent" },
      kind: "chat",
      payload: basePayload,
      createdAt: "2026-04-23T00:00:00.000Z"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a message missing threadId", () => {
    const result = validateMessage({
      id: "m_6",
      sender: { type: "user" },
      kind: "chat",
      payload: basePayload,
      createdAt: "2026-04-23T00:00:00.000Z"
    });
    expect(result.success).toBe(false);
  });
});
