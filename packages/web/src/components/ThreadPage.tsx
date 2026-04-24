import { Navigate, useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useWorkspaceThreads } from "@/hooks/useThreads";

import { ThreadView } from "./ThreadView";

export function ThreadPage() {
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

  return (
    <section className="flex h-full min-h-0 w-full flex-col gap-3 p-4">
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
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate(`/workspaces/${workspaceId}/board`)}
        >
          Back to board
        </Button>
      </header>

      <ThreadView
        threadId={threadId}
        thread={thread}
        className="min-h-0 flex-1"
      />
    </section>
  );
}
