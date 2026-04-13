import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentTeam, CoordinatorProposal, TeamMessage } from "@workhorse/contracts";

import { api } from "@/lib/api";

export const teamQueryKeys = {
  lists: () => ["teams"] as const,
  list: (workspaceId?: string) => ["teams", "list", workspaceId ?? "all"] as const,
  detail: (teamId?: string | null) => ["teams", "detail", teamId ?? "none"] as const,
  messages: (teamId?: string | null, parentTaskId?: string) =>
    ["teams", "messages", teamId ?? "none", parentTaskId ?? "all"] as const,
  proposals: (teamId?: string | null, parentTaskId?: string) =>
    ["teams", "proposals", teamId ?? "none", parentTaskId ?? "all"] as const
};

export function useTeams(workspaceId?: string) {
  return useQuery({
    queryKey: teamQueryKeys.list(workspaceId),
    queryFn: async (): Promise<AgentTeam[]> => {
      const response = await api.listTeams(workspaceId);
      return response.items;
    }
  });
}

export function useTeam(teamId: string | null) {
  return useQuery({
    queryKey: teamQueryKeys.detail(teamId),
    queryFn: async (): Promise<AgentTeam | null> => {
      if (!teamId) {
        return null;
      }
      const response = await api.getTeam(teamId);
      return response.team;
    },
    enabled: Boolean(teamId)
  });
}

export function useTeamMessages(teamId: string | null, parentTaskId?: string) {
  return useQuery({
    queryKey: teamQueryKeys.messages(teamId, parentTaskId),
    queryFn: async (): Promise<TeamMessage[]> => {
      if (!teamId) {
        return [];
      }
      const response = await api.listTeamMessages(teamId, { parentTaskId });
      return response.items;
    },
    enabled: Boolean(teamId)
  });
}

export function usePostTeamMessage(
  teamId: string | null,
  parentTaskId: string | null
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (content: string) => {
      if (!teamId || !parentTaskId) {
        throw new Error("Team message context is unavailable.");
      }

      const response = await api.postTeamMessage(teamId, {
        parentTaskId,
        content
      });
      return response.item;
    },
    onSuccess: async () => {
      if (!teamId || !parentTaskId) {
        return;
      }

      await queryClient.invalidateQueries({
        queryKey: teamQueryKeys.messages(teamId, parentTaskId)
      });
    }
  });
}

export function useTeamProposals(teamId: string | null, parentTaskId?: string) {
  return useQuery({
    queryKey: teamQueryKeys.proposals(teamId, parentTaskId),
    queryFn: async (): Promise<CoordinatorProposal[]> => {
      if (!teamId) {
        return [];
      }
      const response = await api.listProposals(teamId, { parentTaskId });
      return response.items;
    },
    enabled: Boolean(teamId)
  });
}
