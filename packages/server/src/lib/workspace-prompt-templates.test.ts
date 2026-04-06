import { describe, expect, it } from "vitest";

import { resolveWorkspacePromptTemplates } from "./workspace-prompt-templates.js";

describe("resolveWorkspacePromptTemplates", () => {
  it("normalizes CRLF line endings in stored prompt templates", () => {
    expect(
      resolveWorkspacePromptTemplates({
        promptTemplates: {
          coding: "Task: Example\r\n\r\nFollow the plan.\r\n"
        }
      })
    ).toEqual({
      coding: "Task: Example\n\nFollow the plan.\n"
    });
  });

  it("drops whitespace-only templates and returns undefined when nothing remains", () => {
    expect(
      resolveWorkspacePromptTemplates({
        promptTemplates: {
          review: " \r\n\t "
        }
      })
    ).toBeUndefined();
  });

  it("keeps valid partial template inputs while discarding blank and invalid entries", () => {
    expect(
      resolveWorkspacePromptTemplates({
        promptTemplates: {
          plan: "Task: Example",
          coding: "\n\t ",
          review: "Review task\r\nwith details",
          reviewFollowUp: 42
        } as unknown as {
          plan?: string;
          coding?: string;
          review?: string;
          reviewFollowUp?: string;
        }
      })
    ).toEqual({
      plan: "Task: Example",
      review: "Review task\nwith details"
    });
  });
});
