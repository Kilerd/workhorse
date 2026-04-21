import { useNavigate } from "react-router-dom";
import type { AccountAgent } from "@workhorse/contracts";

import { Button } from "@/components/ui/button";
import { AgentCard } from "@/components/AgentCard";

interface Props {
  agents: AccountAgent[];
  loading?: boolean;
  error?: string | null;
}

export function AgentsPage({ agents, loading, error }: Props) {
  const navigate = useNavigate();

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 lg:px-5">
        <div className="grid gap-1.5">
          <span className="section-kicker">Agent library</span>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => navigate("/")}>
              Back
            </Button>
            <h1 className="m-0 text-[1.5rem] font-[590] tracking-[-0.035em]">Agents</h1>
            <span className="text-[0.82rem] text-[var(--muted)]">
              {agents.length} configured
            </span>
          </div>
        </div>
        <Button type="button" size="sm" onClick={() => navigate("/agents/new")}>
          New Agent
        </Button>
      </div>

      <div className="overflow-y-auto px-4 pb-4 pt-3.5 lg:px-5 lg:pb-5">
        {loading ? (
          <p className="text-[0.9rem] text-[var(--muted)]">Loading agents…</p>
        ) : error ? (
          <p className="text-[0.9rem] text-[var(--danger)]">{error}</p>
        ) : agents.length === 0 ? (
          <div className="surface-card mx-auto flex max-w-[28rem] flex-col items-center justify-center gap-3 px-5 py-12 text-center">
            <p className="text-[0.95rem] text-[var(--muted)]">
              No agents yet. Create account-level agents first, then mount them into workspaces.
            </p>
            <Button type="button" onClick={() => navigate("/agents/new")}>
              Create Agent
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="text-left"
                onClick={() => navigate(`/agents/${agent.id}`)}
              >
                <AgentCard agent={agent} compact />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
