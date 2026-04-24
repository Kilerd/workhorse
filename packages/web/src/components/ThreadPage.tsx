import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import type { Task, Workspace } from "@workhorse/contracts";

import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import {
  useRestartCoordinatorThread,
  useWorkspaceThreads
} from "@/hooks/useThreads";
import { api } from "@/lib/api";
import { readErrorMessage } from "@/lib/error-message";
import { resolveThreadSessionContext } from "@/lib/thread-session";

import { ThreadView } from "./ThreadView";

interface Props {
  tasks: Task[];
  workspaces: Workspace[];
}

export function ThreadPage({ tasks, workspaces }: Props) {
  const navigate = useNavigate();
  const { workspaceId, threadId } = useParams<{
    workspaceId: string;
    threadId: string;
  }>();

  const threadsQuery = useWorkspaceThreads(workspaceId ?? null);

  if (!workspaceId || !threadId) {
    return <Navigate to="/" replace />;
  }

  const thread = threadsQuery.data?.find((t) => t.id === threadId) ?? null;
  const workspace = useMemo(
    () => workspaces.find((entry) => entry.id === workspaceId) ?? null,
    [workspaceId, workspaces]
  );
  const task = useMemo(
    () =>
      thread?.taskId
        ? tasks.find((entry) => entry.id === thread.taskId) ?? null
        : null,
    [tasks, thread?.taskId]
  );
  const restartCoordinator = useRestartCoordinatorThread(threadId);
  const workspaceGitStatusQuery = useQuery({
    queryKey: ["workspace-git-status", "thread-page", workspace?.id ?? ""],
    queryFn: async () => {
      if (!workspace?.id || !workspace.isGitRepo) {
        return null;
      }
      return api.getWorkspaceGitStatus(workspace.id);
    },
    enabled: Boolean(workspace?.id && workspace.isGitRepo)
  });
  const sessionContext = useMemo(
    () =>
      resolveThreadSessionContext({
        thread,
        workspace,
        task,
        workspaceGitStatus: workspaceGitStatusQuery.data ?? null
      }),
    [task, thread, workspace, workspaceGitStatusQuery.data]
  );
  const branchLabel = useMemo(() => {
    if (!workspace?.isGitRepo) {
      return null;
    }
    if (thread?.kind === "coordinator" && workspaceGitStatusQuery.isLoading) {
      return "Loading…";
    }
    return sessionContext?.branchName ?? "Unavailable";
  }, [
    sessionContext?.branchName,
    thread?.kind,
    workspace?.isGitRepo,
    workspaceGitStatusQuery.isLoading
  ]);
  const worktreeLabel =
    sessionContext?.worktreePath ??
    (thread?.kind === "task" ? "Pending creation" : workspace?.rootPath ?? "Unavailable");

  async function handleRestartCoordinator() {
    try {
      await restartCoordinator.mutateAsync();
      toast({
        title: "Coordinator restarted",
        description: "The thread was rebound to the workspace coordinator."
      });
    } catch (error) {
      toast({
        title: "Couldn't restart coordinator",
        description: readErrorMessage(error, "Unable to restart coordinator."),
        variant: "destructive"
      });
    }
  }

  return (
    <section className="flex h-full min-h-0 w-full flex-col gap-3 overflow-hidden p-4">
      <header className="flex items-center justify-between gap-2">
        <div>
          <p className="section-kicker m-0">Thread</p>
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            {thread
              ? `${thread.kind} · ${thread.coordinatorState}`
              : threadsQuery.isLoading
                ? "Loading thread…"
                : "Thread not found"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {thread?.kind === "coordinator" ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleRestartCoordinator()}
              disabled={restartCoordinator.isPending}
            >
              <RefreshCw className="size-3.5" />
              {restartCoordinator.isPending ? "Restarting" : "Restart"}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate(`/workspaces/${workspaceId}/board`)}
          >
            Back to board
          </Button>
        </div>
      </header>

      <ThreadView
        threadId={threadId}
        thread={thread}
        sessionWorktree={sessionContext ? worktreeLabel : null}
        sessionBranch={branchLabel}
        className="min-h-0 flex-1"
      />
    </section>
  );
}
