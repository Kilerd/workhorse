import { useState } from "react";
import type { Plan, PlanDraft } from "@workhorse/contracts";

import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { useApprovePlan, useRejectPlan } from "@/hooks/usePlans";
import { readErrorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";

interface Props {
  plan: Plan;
  /** Used to invalidate the owning thread's messages after a decision. */
  threadId?: string;
  className?: string;
}

const EXPAND_THRESHOLD = 3;

function statusTone(status: Plan["status"]): string {
  switch (status) {
    case "pending":
      return "border-amber-400/40 bg-amber-400/10 text-amber-100";
    case "approved":
      return "border-emerald-400/40 bg-emerald-400/10 text-emerald-100";
    case "rejected":
      return "border-rose-400/40 bg-rose-400/10 text-rose-100";
    case "superseded":
      return "border-slate-400/40 bg-slate-400/10 text-slate-100";
    default:
      return "border-border bg-panel text-foreground";
  }
}

function DraftItem({ draft, index }: { draft: PlanDraft; index: number }) {
  return (
    <li className="rounded border border-border bg-[var(--panel)] p-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{index + 1}.</span>
        <span className="font-medium">{draft.title}</span>
        {draft.assigneeAgentId ? (
          <span className="rounded bg-slate-500/10 px-1.5 py-0.5 text-xs text-muted-foreground">
            @{draft.assigneeAgentId}
          </span>
        ) : null}
      </div>
      {draft.description ? (
        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
          {draft.description}
        </p>
      ) : null}
      {draft.dependsOn && draft.dependsOn.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          depends on: {draft.dependsOn.join(", ")}
        </p>
      ) : null}
    </li>
  );
}

export function PlanDraftCard({ plan, threadId, className }: Props) {
  const [expanded, setExpanded] = useState(false);
  const approve = useApprovePlan(threadId);
  const reject = useRejectPlan(threadId);

  const canDecide = plan.status === "pending";
  const isBusy = approve.isPending || reject.isPending;

  const shouldCollapse = plan.drafts.length > EXPAND_THRESHOLD && !expanded;
  const visibleDrafts = shouldCollapse
    ? plan.drafts.slice(0, EXPAND_THRESHOLD)
    : plan.drafts;

  async function handleApprove() {
    try {
      await approve.mutateAsync(plan.id);
      toast({ title: "Plan approved" });
    } catch (error) {
      toast({
        title: "Failed to approve plan",
        description: readErrorMessage(error, "Unable to approve plan."),
        variant: "destructive"
      });
    }
  }

  async function handleReject() {
    try {
      await reject.mutateAsync({ planId: plan.id });
      toast({ title: "Plan rejected" });
    } catch (error) {
      toast({
        title: "Failed to reject plan",
        description: readErrorMessage(error, "Unable to reject plan."),
        variant: "destructive"
      });
    }
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-[var(--panel)] p-3",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">
          Plan · {plan.drafts.length} draft
          {plan.drafts.length === 1 ? "" : "s"}
        </div>
        <span
          className={cn(
            "rounded border px-2 py-0.5 text-xs uppercase tracking-wide",
            statusTone(plan.status)
          )}
        >
          {plan.status}
        </span>
      </div>

      <ul className="mt-3 flex flex-col gap-2">
        {visibleDrafts.map((draft, idx) => (
          <DraftItem key={`${plan.id}-${idx}`} draft={draft} index={idx} />
        ))}
      </ul>

      {shouldCollapse ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2 w-full"
          onClick={() => setExpanded(true)}
        >
          Show {plan.drafts.length - EXPAND_THRESHOLD} more
        </Button>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleReject}
          disabled={!canDecide || isBusy}
        >
          Reject
        </Button>
        <Button
          size="sm"
          onClick={handleApprove}
          disabled={!canDecide || isBusy}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}
