import type {
  Workspace,
  WorkspaceCodexSettings
} from "@workhorse/contracts";

export const DEFAULT_WORKSPACE_CODEX_SETTINGS: WorkspaceCodexSettings = {
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write"
};

export function resolveWorkspaceCodexSettings(
  workspace:
    | Pick<Workspace, "codexSettings">
    | { codexSettings?: Partial<WorkspaceCodexSettings> | undefined }
    | undefined
): WorkspaceCodexSettings {
  return {
    approvalPolicy:
      workspace?.codexSettings?.approvalPolicy ??
      DEFAULT_WORKSPACE_CODEX_SETTINGS.approvalPolicy,
    sandboxMode:
      workspace?.codexSettings?.sandboxMode ??
      DEFAULT_WORKSPACE_CODEX_SETTINGS.sandboxMode
  };
}
