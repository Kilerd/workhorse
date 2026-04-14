import type { AgentRole, AgentTeam, TeamAgent } from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  team: AgentTeam;
  workspaceName?: string;
  active?: boolean;
  compact?: boolean;
}

function findCoordinator(agents: TeamAgent[]) {
  return agents.find((agent) => agent.role === "coordinator") ?? null;
}

function countWorkers(agents: TeamAgent[]) {
  return agents.filter((agent) => agent.role === "worker").length;
}

function roleTone(role: AgentRole) {
  return role === "coordinator"
    ? "border-[rgba(255,79,0,0.28)] bg-[rgba(255,79,0,0.08)] text-[var(--accent-strong)]"
    : "border-[rgba(79,92,98,0.24)] bg-[rgba(79,92,98,0.06)] text-[var(--info)]";
}

export function TeamCard({
  team,
  workspaceName,
  active = false,
  compact = false
}: Props) {
  const coordinator = findCoordinator(team.agents);
  const workerCount = countWorkers(team.agents);

  return (
    <article
      className={cn(
        "grid gap-3 rounded-[var(--radius-lg)] border bg-[var(--panel)] p-4 text-left",
        active
          ? "border-[var(--accent)] bg-[rgba(255,79,0,0.05)]"
          : "border-border"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex min-h-7 items-center rounded-full border border-[rgba(255,79,0,0.24)] bg-[rgba(255,79,0,0.08)] px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--accent-strong)]">
              Team
            </span>
            <span className="inline-flex min-h-7 items-center rounded-full border border-border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--muted)]">
              {team.agents.length} agents
            </span>
          </div>
          <h3 className="mt-3 m-0 text-[1rem] font-semibold leading-[1.35]">
            {team.name}
          </h3>
        </div>
        <span className="rounded-full border border-border px-2.5 py-1 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]">
          {titleCase(team.prStrategy)}
        </span>
      </div>

      {team.description ? (
        <p
          className={cn(
            "m-0 text-[0.86rem] leading-[1.6] text-[var(--muted)]",
            compact && "[display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
          )}
        >
          {team.description}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {coordinator ? (
          <span className={cn("inline-flex min-h-7 items-center rounded-full border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em]", roleTone("coordinator"))}>
            coordinator · {coordinator.agentName}
          </span>
        ) : null}
        {workerCount > 0 ? (
          <span className={cn("inline-flex min-h-7 items-center rounded-full border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em]", roleTone("worker"))}>
            {workerCount} workers
          </span>
        ) : null}
        <span className="inline-flex min-h-7 items-center rounded-full border border-border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--muted)]">
          {team.autoApproveSubtasks ? "Auto-approve subtasks" : "Manual subtask review"}
        </span>
      </div>

      <div className="grid gap-1 text-[0.76rem] text-[var(--muted)]">
        {workspaceName ? <span>Workspace · {workspaceName}</span> : null}
        <span>Updated {formatRelativeTime(team.updatedAt)}</span>
      </div>
    </article>
  );
}
