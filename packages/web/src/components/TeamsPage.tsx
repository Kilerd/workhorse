import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentTeam, Workspace } from "@workhorse/contracts";

import { Button } from "@/components/ui/button";
import { TeamCard } from "@/components/TeamCard";

interface Props {
  teams: AgentTeam[];
  workspaces: Workspace[];
  loading?: boolean;
  error?: string | null;
}

export function TeamsPage({ teams, workspaces, loading, error }: Props) {
  const navigate = useNavigate();
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((w) => [w.id, w.name])),
    [workspaces]
  );

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Button type="button" variant="secondary" size="sm" onClick={() => navigate("/")}>
            Back
          </Button>
          <h1 className="m-0 text-[1.2rem] font-semibold">Teams</h1>
          <span className="text-[0.82rem] text-[var(--muted)]">
            {teams.length} configured
          </span>
        </div>
        <Button type="button" size="sm" onClick={() => navigate("/teams/new")}>
          New Team
        </Button>
      </div>

      <div className="overflow-y-auto p-4">
        {loading ? (
          <p className="text-[0.9rem] text-[var(--muted)]">Loading teams…</p>
        ) : error ? (
          <p className="text-[0.9rem] text-[var(--danger)]">{error}</p>
        ) : teams.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <p className="text-[0.95rem] text-[var(--muted)]">
              No teams yet. Create a team to wire a coordinator, workers, and team-message execution flow.
            </p>
            <Button type="button" onClick={() => navigate("/teams/new")}>
              Create Team
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {teams.map((team) => (
              <button
                key={team.id}
                type="button"
                className="text-left transition-transform hover:-translate-y-px"
                onClick={() => navigate(`/teams/${team.id}`)}
              >
                <TeamCard
                  team={team}
                  workspaceName={workspaceNames.get(team.workspaceId)}
                  compact
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
