import { describe, expect, it } from "vitest";

import { resolveWorkspacePromptTemplates } from "./workspace-prompt-templates.js";

describe("resolveWorkspacePromptTemplates", () => {
  it("normalizes CRLF and bare CR line endings in stored prompt templates", () => {
    expect(
      resolveWorkspacePromptTemplates({
        promptTemplates: {
          coding: "Task: Example\rSecond line\r\n\r\nFollow the plan.\r"
        }
      })
    ).toEqual({
      coding: "Task: Example\nSecond line\n\nFollow the plan.\n"
    });
  });

  it("drops whitespace-only templates and returns undefined when nothing remains", () => {
    expect(
      resolveWorkspacePromptTemplates({
        promptTemplates: {
          coding: " \r\n\t "
        }
      })
    ).toBeUndefined();
  });

  it("ignores invalid entries while keeping valid templates", () => {
    expect(
      resolveWorkspacePromptTemplates({
        promptTemplates: {
          coding: 42 as unknown as string
        }
      })
    ).toBeUndefined();
  });
});
