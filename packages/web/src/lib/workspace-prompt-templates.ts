import type {
  WorkspacePromptTemplateId,
  WorkspacePromptTemplates
} from "@workhorse/contracts";
import { WORKSPACE_PROMPT_TEMPLATE_IDS } from "@workhorse/contracts";

export const EMPTY_WORKSPACE_PROMPT_TEMPLATES = Object.freeze<
  Record<WorkspacePromptTemplateId, string>
>({
  plan: "",
  coding: "",
  review: "",
  reviewFollowUp: ""
});

export function createWorkspacePromptTemplateState(
  templates?: WorkspacePromptTemplates
): Record<WorkspacePromptTemplateId, string> {
  return {
    plan: templates?.plan ?? "",
    coding: templates?.coding ?? "",
    review: templates?.review ?? "",
    reviewFollowUp: templates?.reviewFollowUp ?? ""
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
