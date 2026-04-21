import { useQuery } from "@tanstack/react-query";
import type { WorkspaceChannel } from "@workhorse/contracts";

import { api } from "@/lib/api";

export const workspaceChannelQueryKeys = {
  lists: () => ["workspace-channels"] as const,
  list: (workspaceId: string) => ["workspace-channels", workspaceId] as const
};

export function useWorkspaceChannels(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId
      ? workspaceChannelQueryKeys.list(workspaceId)
      : workspaceChannelQueryKeys.lists(),
    queryFn: async (): Promise<WorkspaceChannel[]> => {
      if (!workspaceId) {
        return [];
      }
      return (await api.listWorkspaceChannels(workspaceId)).items;
    },
    enabled: Boolean(workspaceId)
  });
}
