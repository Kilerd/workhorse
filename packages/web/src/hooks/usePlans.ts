import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Plan } from "@workhorse/contracts";

import { api } from "@/lib/api";

import { threadQueryKeys } from "./useThreads";

export const planQueryKeys = {
  all: () => ["plans"] as const,
  detail: (planId: string) => ["plans", planId] as const
};

export function usePlan(planId: string | null) {
  return useQuery({
    queryKey: planId ? planQueryKeys.detail(planId) : planQueryKeys.all(),
    queryFn: async (): Promise<Plan | null> => {
      if (!planId) return null;
      return (await api.getPlan(planId)).plan;
    },
    enabled: Boolean(planId)
  });
}

/**
 * Shared invalidation: after approve/reject, the plan itself, the thread
 * that owns it, and the task board (new agent_plan tasks) all need a refresh.
 */
function buildPlanMutationInvalidator(
  queryClient: ReturnType<typeof useQueryClient>,
  threadId?: string
) {
  return async (plan: Plan) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: planQueryKeys.detail(plan.id)
      }),
      queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      threadId
        ? queryClient.invalidateQueries({
            queryKey: threadQueryKeys.messages(threadId)
          })
        : queryClient.invalidateQueries({ queryKey: ["threads"] })
    ]);
  };
}

export function useApprovePlan(threadId?: string) {
  const queryClient = useQueryClient();
  const invalidate = buildPlanMutationInvalidator(queryClient, threadId);
  return useMutation({
    mutationFn: async (planId: string): Promise<Plan> => {
      const response = await api.approvePlan(planId);
      return response.plan;
    },
    onSuccess: invalidate
  });
}

export interface RejectPlanInput {
  planId: string;
  reason?: string;
}

export function useRejectPlan(threadId?: string) {
  const queryClient = useQueryClient();
  const invalidate = buildPlanMutationInvalidator(queryClient, threadId);
  return useMutation({
    mutationFn: async ({ planId, reason }: RejectPlanInput): Promise<Plan> => {
      const response = await api.rejectPlan(planId, reason);
      return response.plan;
    },
    onSuccess: invalidate
  });
}
