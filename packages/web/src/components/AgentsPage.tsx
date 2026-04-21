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
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Button type="button" variant="secondary" size="sm" onClick={() => navigate("/")}>
            Back
          </Button>
          <h1 className="m-0 text-[1.2rem] font-semibold">Agents</h1>
          <span className="text-[0.82rem] text-[var(--muted)]">{agents.length} configured</span>
        </div>
        <Button type="button" size="sm" onClick={() => navigate("/agents/new")}>
          New Agent
        </Button>
      </div>

      <div className="overflow-y-auto p-4">
        {loading ? (
          <p className="text-[0.9rem] text-[var(--muted)]">Loading agents…</p>
        ) : error ? (
          <p className="text-[0.9rem] text-[var(--danger)]">{error}</p>
        ) : agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
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
                className="text-left transition-transform hover:-translate-y-px"
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
