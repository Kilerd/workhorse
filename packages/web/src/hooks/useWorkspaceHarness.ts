import { useQuery } from "@tanstack/react-query";
import type { WorkspaceHarness } from "@workhorse/contracts";

import { api } from "@/lib/api";

export const workspaceHarnessQueryKeys = {
  detail: (workspaceId?: string | null) =>
    ["workspace-harness", "detail", workspaceId ?? "none"] as const
};

export function useWorkspaceHarness(
  workspaceId: string | null,
  options: { enabled?: boolean } = {}
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: workspaceHarnessQueryKeys.detail(workspaceId),
    queryFn: async (): Promise<WorkspaceHarness> => {
      if (!workspaceId) {
        return { files: [] };
      }
      return api.getWorkspaceHarness(workspaceId);
    },
    enabled: enabled && Boolean(workspaceId)
  });
}
