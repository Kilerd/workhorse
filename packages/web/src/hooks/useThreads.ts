import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Message, MessageKind, Thread } from "@workhorse/contracts";

import { api } from "@/lib/api";

export const threadQueryKeys = {
  lists: () => ["threads"] as const,
  list: (workspaceId: string) => ["threads", "workspace", workspaceId] as const,
  messages: (threadId: string) => ["threads", "messages", threadId] as const
};

export function useWorkspaceThreads(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId
      ? threadQueryKeys.list(workspaceId)
      : threadQueryKeys.lists(),
    queryFn: async (): Promise<Thread[]> => {
      if (!workspaceId) return [];
      return (await api.listWorkspaceThreads(workspaceId)).items;
    },
    enabled: Boolean(workspaceId)
  });
}

export function useThreadMessages(threadId: string | null) {
  return useQuery({
    queryKey: threadId
      ? threadQueryKeys.messages(threadId)
      : ["threads", "messages", "none"],
    queryFn: async (): Promise<Message[]> => {
      if (!threadId) return [];
      return (await api.listThreadMessages(threadId)).items;
    },
    enabled: Boolean(threadId)
  });
}

export interface PostThreadMessageInput {
  content: string;
  kind?: MessageKind;
}

export function usePostThreadMessage(threadId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PostThreadMessageInput): Promise<Message> => {
      if (!threadId) {
        throw new Error("No thread selected");
      }
      const response = await api.postThreadMessage(threadId, {
        content: input.content,
        kind: input.kind
      });
      return response.message;
    },
    onSuccess: async () => {
      if (threadId) {
        await queryClient.invalidateQueries({
          queryKey: threadQueryKeys.messages(threadId)
        });
      }
    }
  });
}

export function useRestartCoordinatorThread(threadId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!threadId) {
        throw new Error("No thread selected");
      }
      const response = await api.restartCoordinatorThread(threadId);
      return response.thread;
    },
    onSuccess: async (thread) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: threadQueryKeys.lists() }),
        queryClient.invalidateQueries({
          queryKey: threadQueryKeys.list(thread.workspaceId)
        }),
        queryClient.invalidateQueries({
          queryKey: threadQueryKeys.messages(thread.id)
        })
      ]);
    }
  });
}
