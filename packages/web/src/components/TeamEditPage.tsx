import { useNavigate, useParams } from "react-router-dom";
import type { Workspace } from "@workhorse/contracts";

import { Button } from "@/components/ui/button";
import { TeamForm } from "@/components/TeamForm";
import { useTeam, useTeamMutations } from "@/hooks/useTeams";

interface Props {
  workspaces: Workspace[];
  selectedWorkspaceId: string | "all";
}

export function TeamEditPage({ workspaces, selectedWorkspaceId }: Props) {
  const navigate = useNavigate();
  const { teamId } = useParams<{ teamId: string }>();
  const isNew = teamId === "new";
  const teamQuery = useTeam(isNew ? null : teamId ?? null);
  const mutations = useTeamMutations();

  const mode = isNew ? "create" : "edit";
  const team = isNew ? null : teamQuery.data;
  const defaultWorkspaceId =
    selectedWorkspaceId !== "all" ? selectedWorkspaceId : workspaces[0]?.id;

  if (!isNew && teamQuery.isLoading) {
    return (
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <Button type="button" variant="secondary" size="sm" onClick={() => navigate("/teams")}>
            Back
          </Button>
          <h1 className="m-0 text-[1.2rem] font-semibold">Loading…</h1>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Button type="button" variant="secondary" size="sm" onClick={() => navigate("/teams")}>
          Back
        </Button>
        <h1 className="m-0 text-[1.2rem] font-semibold">
          {isNew ? "New Team" : team?.name ?? "Edit Team"}
        </h1>
      </div>

      <div className="overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <TeamForm
            key={`${mode}:${team?.id ?? "new"}:${defaultWorkspaceId}`}
            mode={mode as "create" | "edit"}
            team={team}
            workspaces={workspaces}
            defaultWorkspaceId={defaultWorkspaceId}
            submitting={mutations.isPending}
            onSubmit={async (values) => {
              if (isNew) {
                const created = await mutations.create(values);
                navigate(`/teams/${created.id}`, { replace: true });
              } else if (teamId) {
                await mutations.update({
                  teamId,
                  body: {
                    name: values.name,
                    description: values.description,
                    prStrategy: values.prStrategy,
                    autoApproveSubtasks: values.autoApproveSubtasks,
                    agents: values.agents
                  }
                });
              }
            }}
            onDelete={
              mode === "edit" && teamId
                ? async () => {
                    await mutations.remove(teamId);
                    navigate("/teams");
                  }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
