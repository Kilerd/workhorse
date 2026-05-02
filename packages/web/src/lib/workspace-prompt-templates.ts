import type {
  WorkspacePromptTemplateId,
  WorkspacePromptTemplates
} from "@workhorse/contracts";
import { WORKSPACE_PROMPT_TEMPLATE_IDS } from "@workhorse/contracts";

export const EMPTY_WORKSPACE_PROMPT_TEMPLATES = Object.freeze<
  Record<WorkspacePromptTemplateId, string>
>({
  coding: ""
});

export function createWorkspacePromptTemplateState(
  templates?: WorkspacePromptTemplates
): Record<WorkspacePromptTemplateId, string> {
  return {
    coding: templates?.coding ?? ""
  };
}

export function serializeWorkspacePromptTemplates(
  templates: Record<WorkspacePromptTemplateId, string>
): WorkspacePromptTemplates {
  const next: WorkspacePromptTemplates = {};

  for (const templateId of WORKSPACE_PROMPT_TEMPLATE_IDS) {
    const value = templates[templateId];
    if (!value.trim()) {
      continue;
    }
    next[templateId] = value;
  }

  return next;
}
