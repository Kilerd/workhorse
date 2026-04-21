import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CoordinatorProposal } from "@workhorse/contracts";

import { api } from "@/lib/api";
import type { CoordinationMessage, CoordinationScope } from "@/lib/coordination";
import { normalizeCoordinationMessages } from "@/lib/coordination";

export const coordinationQueryKeys = {
  messages: (scope: CoordinationScope) => {
    if (scope.kind === "legacy_team") {
      return ["coordination", "messages", "legacy", scope.teamId, scope.parentTaskId] as const;
    }
    if (scope.kind === "workspace") {
      return ["coordination", "messages", "workspace", scope.workspaceId, scope.parentTaskId] as const;
    }
    return ["coordination", "messages", "none"] as const;
  },
  proposals: (scope: CoordinationScope) => {
    if (scope.kind === "legacy_team") {
      return ["coordination", "proposals", "legacy", scope.teamId, scope.parentTaskId] as const;
    }
    if (scope.kind === "workspace") {
      return ["coordination", "proposals", "workspace", scope.workspaceId, scope.parentTaskId] as const;
    }
    return ["coordination", "proposals", "none"] as const;
  }
};

export function useCoordinationMessages(scope: CoordinationScope) {
  return useQuery({
    queryKey: coordinationQueryKeys.messages(scope),
    queryFn: async (): Promise<CoordinationMessage[]> => {
      if (scope.kind === "legacy_team") {
        const response = await api.listTeamMessages(scope.teamId, {
          parentTaskId: scope.parentTaskId
        });
        return normalizeCoordinationMessages(response.items);
      }

      if (scope.kind === "workspace") {
        const response = await api.listTaskMessages(scope.workspaceId, {
          parentTaskId: scope.parentTaskId
        });
        return normalizeCoordinationMessages(response.items);
      }

      return [];
    },
    enabled: scope.kind !== "none"
  });
}

export function usePostCoordinationMessage(scope: CoordinationScope) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (content: string) => {
      if (scope.kind === "legacy_team") {
        const response = await api.postTeamMessage(scope.teamId, {
          parentTaskId: scope.parentTaskId,
          content
        });
        return response.item;
      }

      if (scope.kind === "workspace") {
        const response = await api.postTaskMessage(scope.workspaceId, {
          parentTaskId: scope.parentTaskId,
          content
        });
        return response.item;
      }

      throw new Error("Coordination message context is unavailable.");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: coordinationQueryKeys.messages(scope)
      });
    }
  });
}

export function useCoordinationProposals(scope: CoordinationScope) {
  return useQuery({
    queryKey: coordinationQueryKeys.proposals(scope),
    queryFn: async (): Promise<CoordinatorProposal[]> => {
      if (scope.kind === "legacy_team") {
        const response = await api.listProposals(scope.teamId, {
          parentTaskId: scope.parentTaskId
        });
        return response.items;
      }

      if (scope.kind === "workspace") {
        const response = await api.listWorkspaceProposals(scope.workspaceId, {
          parentTaskId: scope.parentTaskId
        });
        return response.items;
      }

      return [];
    },
    enabled: scope.kind !== "none"
  });
}

export function useCoordinationProposalActions(scope: CoordinationScope) {
  const queryClient = useQueryClient();

  async function invalidate() {
    await queryClient.invalidateQueries({
      queryKey: coordinationQueryKeys.proposals(scope)
    });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  const approveMutation = useMutation({
    mutationFn: async (proposalId: string) => {
      if (scope.kind === "legacy_team") {
        return api.approveProposal(scope.teamId, proposalId);
      }
      if (scope.kind === "workspace") {
        return api.approveWorkspaceProposal(scope.workspaceId, proposalId);
      }
      throw new Error("Coordination proposal context is unavailable.");
    },
    onSuccess: invalidate
  });

  const rejectMutation = useMutation({
    mutationFn: async (proposalId: string) => {
      if (scope.kind === "legacy_team") {
        return api.rejectProposal(scope.teamId, proposalId);
      }
      if (scope.kind === "workspace") {
        return api.rejectWorkspaceProposal(scope.workspaceId, proposalId);
      }
      throw new Error("Coordination proposal context is unavailable.");
    },
    onSuccess: invalidate
  });

  return {
    approve: approveMutation.mutateAsync,
    reject: rejectMutation.mutateAsync,
    isPending: approveMutation.isPending || rejectMutation.isPending
  };
}
