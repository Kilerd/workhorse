import { describe, expect, it } from "vitest";

import {
  createDefaultRunnerConfig,
  normalizeAgentPayload,
  validateAgentPayload
} from "./AgentForm";

describe("AgentForm helpers", () => {
  it("creates sensible defaults for each runner type", () => {
    const codex = createDefaultRunnerConfig("codex");
    expect(codex).toMatchObject({
      type: "codex",
      approvalMode: "default",
      model: { mode: "builtin", reasoningEffort: "medium" }
    });
    const claude = createDefaultRunnerConfig("claude");
    expect(claude).toMatchObject({
      type: "claude",
      permissionMode: "default",
      model: { mode: "builtin", reasoningEffort: "medium" }
    });
    expect(createDefaultRunnerConfig("shell")).toEqual({
      type: "shell",
      command: "npm test"
    });
  });

  it("normalizes whitespace and preserves model config + env for claude", () => {
    const payload = normalizeAgentPayload({
      name: "  Frontend Coordinator  ",
      description: "  Owns UI delivery.  ",
      runnerConfig: {
        type: "claude",
        prompt: "",
        agent: "  ",
        model: { mode: "builtin", id: "claude-sonnet-4-6", reasoningEffort: "high" },
        permissionMode: "dontAsk",
        env: { TOKEN: "abc" }
      }
    });

    expect(payload).toEqual({
      name: "Frontend Coordinator",
      description: "Owns UI delivery.",
      runnerConfig: {
        type: "claude",
        prompt: "",
        model: { mode: "builtin", id: "claude-sonnet-4-6", reasoningEffort: "high" },
        permissionMode: "dontAsk",
        env: { TOKEN: "abc" }
      }
    });
  });

  it("drops empty model id and empty env map", () => {
    const payload = normalizeAgentPayload({
      name: "Coordinator",
      description: "",
      runnerConfig: {
        type: "codex",
        prompt: "",
        model: { mode: "custom", id: "   " },
        approvalMode: "default"
      }
    });

    expect(payload.runnerConfig).toEqual({
      type: "codex",
      prompt: "",
      model: undefined,
      approvalMode: "default"
    });
  });

  it("validates required names and shell commands; no prompt requirement", () => {
    expect(
      validateAgentPayload({
        name: "   ",
        description: "",
        runnerConfig: { type: "codex", prompt: "", approvalMode: "default" }
      })
    ).toBe("Agent name is required.");

    expect(
      validateAgentPayload({
        name: "Shell Agent",
        description: "",
        runnerConfig: { type: "shell", command: "   " }
      })
    ).toBe("Shell runner command is required.");

    expect(
      validateAgentPayload({
        name: "Coordinator",
        description: "",
        runnerConfig: { type: "codex", prompt: "", approvalMode: "default" }
      })
    ).toBeNull();
  });
});
