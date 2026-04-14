import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CoordinatorProposal } from "@workhorse/contracts";

import { api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { teamQueryKeys } from "@/hooks/useTeams";

interface Props {
  teamId: string;
  parentTaskId: string;
  proposals: CoordinatorProposal[];
  loading?: boolean;
}

function statusChip(status: CoordinatorProposal["status"]) {
  switch (status) {
    case "approved":
      return "border-[rgba(47,117,88,0.3)] bg-[rgba(47,117,88,0.08)] text-[var(--success)]";
    case "rejected":
      return "border-[rgba(181,74,74,0.3)] bg-[rgba(181,74,74,0.08)] text-[var(--danger)]";
    default:
      return "border-[rgba(166,109,26,0.3)] bg-[rgba(166,109,26,0.08)] text-[var(--warning)]";
  }
}

interface ProposalCardProps {
  teamId: string;
  proposal: CoordinatorProposal;
}

function ProposalCard({ teamId, proposal }: ProposalCardProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: teamQueryKeys.proposals(teamId, proposal.parentTaskId)
    });
    // Also invalidate tasks so the parent task column update is reflected
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  const approveMutation = useMutation({
    mutationFn: () => api.approveProposal(teamId, proposal.id),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to approve proposal";
      setError(msg);
    }
  });

  const rejectMutation = useMutation({
    mutationFn: () => api.rejectProposal(teamId, proposal.id),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to reject proposal";
      setError(msg);
    }
  });

  const isPending = proposal.status === "pending";
  const isBusy = approveMutation.isPending || rejectMutation.isPending;

  return (
    <div className="grid gap-3 rounded-[var(--radius)] border border-border bg-[var(--panel)] p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[0.68rem] uppercase tracking-[0.08em] text-[var(--muted)]">
          {formatRelativeTime(proposal.createdAt)}
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[0.62rem] uppercase tracking-[0.08em]",
            statusChip(proposal.status)
          )}
        >
          {proposal.status}
        </span>
      </div>

      <div className="grid gap-1.5">
        {proposal.drafts.map((draft, index) => (
          <div
            key={index}
            className="grid gap-1 rounded-[var(--radius)] border border-border bg-[var(--surface-soft)] px-3 py-3"
          >
            <p className="m-0 text-[0.9rem] font-medium leading-snug">
              {draft.title}
            </p>
            <p className="m-0 text-[0.76rem] text-[var(--muted)]">
              {draft.assignedAgent}
              {draft.dependencies.length > 0
                ? ` · depends on: ${draft.dependencies.join(", ")}`
                : ""}
            </p>
            {draft.description ? (
              <p className="m-0 text-[0.76rem] leading-[1.55] text-[var(--muted)]">
                {draft.description.length > 140
                  ? `${draft.description.slice(0, 140)}…`
                  : draft.description}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {error ? (
        <p className="m-0 text-[0.78rem] text-[var(--danger)]">{error}</p>
      ) : null}

      {isPending ? (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => approveMutation.mutate()}
            className={cn(
              "inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-full border border-[rgba(47,117,88,0.4)] bg-[rgba(47,117,88,0.08)] px-3 text-[0.82rem] font-semibold text-[var(--success)] transition-[border-color,background-color] hover:bg-[rgba(47,117,88,0.14)] disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {approveMutation.isPending ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => rejectMutation.mutate()}
            className={cn(
              "inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-full border border-[rgba(181,74,74,0.3)] bg-transparent px-3 text-[0.82rem] font-semibold text-[var(--danger)] transition-[border-color,background-color] hover:bg-[rgba(181,74,74,0.08)] disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {rejectMutation.isPending ? "Rejecting…" : "Reject"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function CoordinatorProposalPanel({
  teamId,
  parentTaskId,
  proposals,
  loading = false
}: Props) {
  if (loading) {
    return (
      <p className="m-0 text-[0.72rem] text-[var(--muted)]">Loading proposals…</p>
    );
  }

  if (proposals.length === 0) {
    return (
      <p className="m-0 text-[0.72rem] text-[var(--muted)]">No coordinator proposals yet.</p>
    );
  }

  return (
    <div className="grid gap-2">
      {proposals.map((proposal) => (
        <ProposalCard key={proposal.id} teamId={teamId} proposal={proposal} />
      ))}
    </div>
  );
}
