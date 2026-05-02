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

  it("falls back to empty strings when no templates are provided", () => {
    expect(createWorkspacePromptTemplateState()).toEqual({ coding: "" });
  });
});

describe("serializeWorkspacePromptTemplates", () => {
  it("returns an empty object when the coding template is blank", () => {
    expect(serializeWorkspacePromptTemplates({ coding: "   " })).toEqual({});
  });

  it("keeps the coding template when set", () => {
    expect(
      serializeWorkspacePromptTemplates({ coding: "Task: {{taskTitle}}" })
    ).toEqual({ coding: "Task: {{taskTitle}}" });
  });
});
