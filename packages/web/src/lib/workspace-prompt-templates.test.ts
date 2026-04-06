import { describe, expect, it } from "vitest";

import {
  createWorkspacePromptTemplateState,
  EMPTY_WORKSPACE_PROMPT_TEMPLATES,
  serializeWorkspacePromptTemplates
} from "./workspace-prompt-templates";

describe("createWorkspacePromptTemplateState", () => {
  it("fills missing templates with empty strings", () => {
    expect(createWorkspacePromptTemplateState({ coding: "Prompt: {{taskPrompt}}" })).toEqual({
      ...EMPTY_WORKSPACE_PROMPT_TEMPLATES,
      coding: "Prompt: {{taskPrompt}}"
    });
  });
});

describe("serializeWorkspacePromptTemplates", () => {
  it("returns an empty object when all templates are blank so updates can clear saved templates", () => {
    expect(
      serializeWorkspacePromptTemplates({
        plan: "   ",
        coding: "\n\t",
        review: "",
        reviewFollowUp: "   "
      })
    ).toEqual({});
  });

  it("keeps only non-blank template values", () => {
    expect(
      serializeWorkspacePromptTemplates({
        plan: "",
        coding: "Task: {{taskTitle}}",
        review: " \n",
        reviewFollowUp: "Address {{reviewSummary}}"
      })
    ).toEqual({
      coding: "Task: {{taskTitle}}",
      reviewFollowUp: "Address {{reviewSummary}}"
    });
  });
});
