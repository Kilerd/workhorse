import type { Workspace, WorkspacePromptTemplates } from "@workhorse/contracts";
import { WORKSPACE_PROMPT_TEMPLATE_IDS } from "@workhorse/contracts";

export function resolveWorkspacePromptTemplates(
  workspace:
    | Pick<Workspace, "promptTemplates">
    | { promptTemplates?: Partial<WorkspacePromptTemplates> | undefined }
    | undefined
): WorkspacePromptTemplates | undefined {
  const promptTemplates: WorkspacePromptTemplates = {};

  for (const templateId of WORKSPACE_PROMPT_TEMPLATE_IDS) {
    const value = workspace?.promptTemplates?.[templateId];
    if (typeof value !== "string") {
      continue;
    }

    const normalized = value.replace(/\r\n?/g, "\n");
    if (!normalized.trim()) {
      continue;
    }

    promptTemplates[templateId] = normalized;
  }

  return Object.keys(promptTemplates).length > 0 ? promptTemplates : undefined;
}
