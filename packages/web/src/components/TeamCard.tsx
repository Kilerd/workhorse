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
    ? "border-[rgba(73,214,196,0.28)] bg-[rgba(73,214,196,0.12)] text-[var(--accent-strong)]"
    : "border-[rgba(104,199,246,0.24)] bg-[rgba(104,199,246,0.12)] text-[var(--info)]";
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
        "grid gap-2 rounded-none border bg-[var(--panel)] p-3 text-left",
        active
          ? "border-[var(--accent)] bg-[rgba(73,214,196,0.08)]"
          : "border-border"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex min-h-5 items-center rounded-none border border-[rgba(73,214,196,0.24)] bg-[rgba(73,214,196,0.12)] px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent-strong)]">
              Team
            </span>
            <span className="inline-flex min-h-5 items-center rounded-none border border-border px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--muted)]">
              {team.agents.length} agents
            </span>
          </div>
          <h3 className="mt-2 m-0 text-[0.84rem] font-semibold leading-[1.35]">
            {team.name}
          </h3>
        </div>
        <span className="rounded-none border border-border px-1.5 py-0.5 font-mono text-[0.58rem] uppercase tracking-[0.1em] text-[var(--muted)]">
          {titleCase(team.prStrategy)}
        </span>
      </div>

      {team.description ? (
        <p
          className={cn(
            "m-0 text-[0.72rem] leading-[1.5] text-[var(--muted)]",
            compact && "[display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
          )}
        >
          {team.description}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {coordinator ? (
          <span className={cn("inline-flex min-h-5 items-center rounded-none border px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.1em]", roleTone("coordinator"))}>
            coordinator · {coordinator.agentName}
          </span>
        ) : null}
        {workerCount > 0 ? (
          <span className={cn("inline-flex min-h-5 items-center rounded-none border px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.1em]", roleTone("worker"))}>
            {workerCount} workers
          </span>
        ) : null}
      </div>

      <div className="grid gap-1 text-[0.68rem] text-[var(--muted)]">
        {workspaceName ? <span>Workspace · {workspaceName}</span> : null}
        <span>Updated {formatRelativeTime(team.updatedAt)}</span>
      </div>
    </article>
  );
}
