import type { Workspace } from "@workhorse/contracts";

export function resolveTaskWorkspaceId(
  workspaces: Workspace[],
  selectedWorkspaceId: string | "all"
): string {
  if (
    selectedWorkspaceId !== "all" &&
    workspaces.some((workspace) => workspace.id === selectedWorkspaceId)
  ) {
    return selectedWorkspaceId;
  }

  return workspaces[0]?.id ?? "";
}
