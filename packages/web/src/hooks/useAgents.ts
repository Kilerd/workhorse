import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountAgent, WorkspaceAgent } from "@workhorse/contracts";

import { api } from "@/lib/api";

export const agentQueryKeys = {
  lists: () => ["agents"] as const,
  list: () => ["agents", "list"] as const,
  detail: (agentId?: string | null) => ["agents", "detail", agentId ?? "none"] as const
};

export const workspaceAgentQueryKeys = {
  lists: () => ["workspace-agents"] as const,
  list: (workspaceId?: string | null) =>
    ["workspace-agents", "list", workspaceId ?? "none"] as const
};

export function useAgents() {
  return useQuery({
    queryKey: agentQueryKeys.list(),
    queryFn: async (): Promise<AccountAgent[]> => {
      const response = await api.listAgents();
      return response.items;
    }
  });
}

export function useAgent(agentId: string | null) {
  return useQuery({
    queryKey: agentQueryKeys.detail(agentId),
    queryFn: async (): Promise<AccountAgent | null> => {
      if (!agentId) {
        return null;
      }
      const response = await api.getAgent(agentId);
      return response.agent;
    },
    enabled: Boolean(agentId)
  });
}

export function useAgentMutations() {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async (body: Parameters<typeof api.createAgent>[0]) => {
      const response = await api.createAgent(body);
      return response.agent;
    },
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.lists() });
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.detail(agent.id) });
      await queryClient.invalidateQueries({ queryKey: workspaceAgentQueryKeys.lists() });
    }
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      agentId,
      body
    }: {
      agentId: string;
      body: Parameters<typeof api.updateAgent>[1];
    }) => {
      const response = await api.updateAgent(agentId, body);
      return response.agent;
    },
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.lists() });
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.detail(agent.id) });
      await queryClient.invalidateQueries({ queryKey: workspaceAgentQueryKeys.lists() });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (agentId: string) => api.deleteAgent(agentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.lists() });
      await queryClient.invalidateQueries({ queryKey: workspaceAgentQueryKeys.lists() });
    }
  });

  return {
    create: createMutation.mutateAsync,
    update: updateMutation.mutateAsync,
    remove: deleteMutation.mutateAsync,
    isPending:
      createMutation.isPending || updateMutation.isPending || deleteMutation.isPending
  };
}

export function useWorkspaceAgents(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceAgentQueryKeys.list(workspaceId),
    queryFn: async (): Promise<WorkspaceAgent[]> => {
      if (!workspaceId) {
        return [];
      }
      const response = await api.listWorkspaceAgents(workspaceId);
      return response.items;
    },
    enabled: Boolean(workspaceId)
  });
}

export function useWorkspaceAgentMutations(workspaceId: string | null) {
  const queryClient = useQueryClient();

  async function invalidateWorkspace() {
    await queryClient.invalidateQueries({
      queryKey: workspaceAgentQueryKeys.list(workspaceId)
    });
    await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  }

  const mountMutation = useMutation({
    mutationFn: async (body: Parameters<typeof api.mountAgent>[1]) => {
      if (!workspaceId) {
        throw new Error("Workspace agent context is unavailable.");
      }
      const response = await api.mountAgent(workspaceId, body);
      return response.agent;
    },
    onSuccess: invalidateWorkspace
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({
      agentId,
      role
    }: {
      agentId: string;
      role: WorkspaceAgent["role"];
    }) => {
      if (!workspaceId) {
        throw new Error("Workspace agent context is unavailable.");
      }
      const response = await api.updateAgentRole(workspaceId, agentId, { role });
      return response.agent;
    },
    onSuccess: invalidateWorkspace
  });

  const unmountMutation = useMutation({
    mutationFn: async (agentId: string) => {
      if (!workspaceId) {
        throw new Error("Workspace agent context is unavailable.");
      }
      return api.unmountAgent(workspaceId, agentId);
    },
    onSuccess: invalidateWorkspace
  });

  const updateConfigMutation = useMutation({
    mutationFn: async (body: Parameters<typeof api.updateWorkspaceConfig>[1]) => {
      if (!workspaceId) {
        throw new Error("Workspace config context is unavailable.");
      }
      const response = await api.updateWorkspaceConfig(workspaceId, body);
      return response.workspace;
    },
    onSuccess: async () => {
      await invalidateWorkspace();
    }
  });

  return {
    mount: mountMutation.mutateAsync,
    updateRole: updateRoleMutation.mutateAsync,
    unmount: unmountMutation.mutateAsync,
    updateConfig: updateConfigMutation.mutateAsync,
    isPending:
      mountMutation.isPending ||
      updateRoleMutation.isPending ||
      unmountMutation.isPending ||
      updateConfigMutation.isPending
  };
}
