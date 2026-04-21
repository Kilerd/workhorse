import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { AgentForm } from "@/components/AgentForm";
import { useAgent, useAgentMutations } from "@/hooks/useAgents";

export function AgentEditPage() {
  const navigate = useNavigate();
  const { agentId } = useParams<{ agentId: string }>();
  const isNew = agentId === "new";
  const agentQuery = useAgent(isNew ? null : agentId ?? null);
  const mutations = useAgentMutations();

  const mode = isNew ? "create" : "edit";
  const agent = isNew ? null : agentQuery.data;

  if (!isNew && agentQuery.isLoading) {
    return (
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <Button type="button" variant="secondary" size="sm" onClick={() => navigate("/agents")}>
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
        <Button type="button" variant="secondary" size="sm" onClick={() => navigate("/agents")}>
          Back
        </Button>
        <h1 className="m-0 text-[1.2rem] font-semibold">
          {isNew ? "New Agent" : agent?.name ?? "Edit Agent"}
        </h1>
      </div>

      <div className="overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <AgentForm
            key={`${mode}:${agent?.id ?? "new"}`}
            mode={mode}
            agent={agent}
            submitting={mutations.isPending}
            onSubmit={async (values) => {
              if (isNew) {
                const created = await mutations.create(values);
                navigate(`/agents/${created.id}`, { replace: true });
              } else if (agentId) {
                await mutations.update({
                  agentId,
                  body: values
                });
              }
            }}
            onDelete={
              mode === "edit" && agentId
                ? async () => {
                    await mutations.remove(agentId);
                    navigate("/agents");
                  }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
