import type { AgentTeam, Workspace } from "@workhorse/contracts";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TeamCard } from "./TeamCard";

interface Props {
  teams: AgentTeam[];
  workspaces: Workspace[];
  selectedTeamId: string | null;
  loading?: boolean;
  error?: string | null;
  onSelectTeam(teamId: string): void;
  onCreateTeam(): void;
}

function resolveWorkspaceName(workspaces: Workspace[], workspaceId: string) {
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Unknown";
}

export function TeamList({
  teams,
  workspaces,
  selectedTeamId,
  loading = false,
  error = null,
  onSelectTeam,
  onCreateTeam
}: Props) {
  return (
    <section className="flex min-h-0 flex-col border-r border-border bg-[var(--bg)] max-[1040px]:border-b max-[1040px]:border-r-0">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="m-0 font-mono text-[0.62rem] uppercase tracking-[0.14em] text-[var(--accent)]">
            Agent Teams
          </p>
          <p className="m-0 mt-1 text-[0.74rem] text-[var(--muted)]">
            {teams.length} configured
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={onCreateTeam}>
          New Team
        </Button>
      </div>

      {loading ? (
        <div className="px-4 py-4 text-[0.76rem] text-[var(--muted)]">
          Loading teams…
        </div>
      ) : error ? (
        <div className="px-4 py-4 text-[0.76rem] text-[var(--danger)]">
          {error}
        </div>
      ) : teams.length === 0 ? (
        <div className="grid flex-1 place-items-center px-4 py-6 text-center">
          <div className="grid max-w-[16rem] gap-3">
            <p className="m-0 text-[0.82rem] font-medium">No teams yet</p>
            <p className="m-0 text-[0.74rem] leading-[1.5] text-[var(--muted)]">
              Create a team to wire a coordinator, workers, and team-message execution flow into the board.
            </p>
            <Button type="button" onClick={onCreateTeam}>
              Create Team
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 content-start gap-2 overflow-y-auto p-3">
          {teams.map((team) => (
            <button
              key={team.id}
              type="button"
              onClick={() => onSelectTeam(team.id)}
              className={cn("text-left", selectedTeamId === team.id && "outline-none")}
            >
              <TeamCard
                team={team}
                workspaceName={resolveWorkspaceName(workspaces, team.workspaceId)}
                active={selectedTeamId === team.id}
                compact
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
