import { useEffect, useMemo, useState } from "react";
import type { AgentTeam, CreateTeamBody, Workspace } from "@workhorse/contracts";

import { useTeam } from "@/hooks/useTeams";
import { Button } from "@/components/ui/button";
import { TeamCard } from "./TeamCard";
import { TeamForm } from "./TeamForm";
import { TeamList } from "./TeamList";

interface Props {
  open: boolean;
  teams: AgentTeam[];
  workspaces: Workspace[];
  selectedWorkspaceId: string | "all";
  loading?: boolean;
  error?: string | null;
  submitting?: boolean;
  onClose(): void;
  onCreateTeam(values: CreateTeamBody): Promise<AgentTeam>;
  onUpdateTeam(teamId: string, values: Omit<CreateTeamBody, "workspaceId"> & { workspaceId: string }): Promise<AgentTeam>;
  onDeleteTeam(teamId: string): Promise<unknown>;
}

function resolveWorkspaceName(workspaces: Workspace[], workspaceId: string) {
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Unknown";
}

export function TeamManagementModal({
  open,
  teams,
  workspaces,
  selectedWorkspaceId,
  loading = false,
  error = null,
  submitting = false,
  onClose,
  onCreateTeam,
  onUpdateTeam,
  onDeleteTeam
}: Props) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [mode, setMode] = useState<"create" | "edit">("create");

  useEffect(() => {
    if (!open) {
      return;
    }
    if (mode === "create" && selectedTeamId === null) {
      return;
    }
    if (teams.length > 0) {
      setSelectedTeamId((current) =>
        current && teams.some((team) => team.id === current) ? current : teams[0]!.id
      );
      setMode("edit");
      return;
    }
    setSelectedTeamId(null);
    setMode("create");
  }, [mode, open, selectedTeamId, teams]);

  const selectedTeamQuery = useTeam(mode === "edit" ? selectedTeamId : null);
  const selectedTeam = mode === "edit"
    ? (selectedTeamQuery.data ??
      teams.find((team) => team.id === selectedTeamId) ??
      null)
    : null;
  const defaultWorkspaceId =
    selectedWorkspaceId === "all"
      ? teams[0]?.workspaceId ?? workspaces[0]?.id
      : selectedWorkspaceId;
  const workspaceName = selectedTeam
    ? resolveWorkspaceName(workspaces, selectedTeam.workspaceId)
    : undefined;
  const formKey = useMemo(
    () => `${mode}:${selectedTeam?.id ?? "new"}:${defaultWorkspaceId ?? "none"}`,
    [defaultWorkspaceId, mode, selectedTeam?.id]
  );

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(7,10,12,0.72)] p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="grid h-[min(88vh,52rem)] w-[min(1120px,100%)] overflow-hidden border border-border bg-[var(--bg)] shadow-[0_24px_80px_rgba(0,0,0,0.35)] max-[1040px]:grid-rows-[minmax(16rem,22rem)_minmax(0,1fr)] md:grid-cols-[320px_minmax(0,1fr)]"
        onClick={(event) => event.stopPropagation()}
      >
        <TeamList
          teams={teams}
          workspaces={workspaces}
          selectedTeamId={mode === "edit" ? selectedTeamId : null}
          loading={loading}
          error={error}
          onSelectTeam={(teamId) => {
            setSelectedTeamId(teamId);
            setMode("edit");
          }}
          onCreateTeam={() => {
            setSelectedTeamId(null);
            setMode("create");
          }}
        />

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 max-[720px]:px-4">
            <div>
              <p className="m-0 font-mono text-[0.62rem] uppercase tracking-[0.14em] text-[var(--accent)]">
                Team Workspace
              </p>
              <p className="m-0 mt-1 text-[0.74rem] text-[var(--muted)]">
                Create teams, edit coordinators, and keep agent config in sync with task creation.
              </p>
            </div>
            <Button type="button" variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>

          <div className="grid min-h-0 overflow-hidden md:grid-cols-[minmax(0,1fr)_320px]">
            <TeamForm
              key={formKey}
              mode={mode}
              team={selectedTeam}
              workspaces={workspaces}
              defaultWorkspaceId={defaultWorkspaceId}
              submitting={submitting}
              onSubmit={async (values) => {
                if (mode === "create") {
                  const created = await onCreateTeam(values);
                  setSelectedTeamId(created.id);
                  setMode("edit");
                  return;
                }

                if (!selectedTeamId) {
                  return;
                }
                await onUpdateTeam(selectedTeamId, values);
              }}
              onDelete={
                mode === "edit" && selectedTeamId
                  ? async () => {
                      if (!window.confirm("Delete this team?")) {
                        return;
                      }
                      await onDeleteTeam(selectedTeamId);
                      setSelectedTeamId(null);
                      setMode("create");
                    }
                  : undefined
              }
            />

            <div className="hidden min-h-0 border-l border-border bg-[var(--surface-faint)] p-4 md:grid md:content-start gap-4">
              {selectedTeam ? (
                <TeamCard
                  team={selectedTeam}
                  workspaceName={workspaceName}
                />
              ) : (
                <div className="rounded-none border border-dashed border-border px-4 py-5 text-[0.74rem] text-[var(--muted)]">
                  Create a team to preview its summary card here.
                </div>
              )}
              <div className="rounded-none border border-border bg-[var(--panel)] p-4 text-[0.74rem] leading-[1.6] text-[var(--muted)]">
                <p className="m-0 font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                  What this UI does
                </p>
                <p className="m-0 mt-2">
                  Team tasks inherit the coordinator runner automatically. Child tasks and team messages appear on the board once execution begins.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
