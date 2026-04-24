import type { AccountAgent, ModelConfig } from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  agent: AccountAgent;
  active?: boolean;
  compact?: boolean;
}

function describeModelConfig(model: ModelConfig | undefined): string | null {
  if (!model?.id.trim()) {
    return null;
  }

  if (model.mode === "builtin") {
    return model.reasoningEffort ? `${model.id} · ${model.reasoningEffort}` : model.id;
  }

  return model.id;
}

function describeRunner(agent: AccountAgent): string {
  switch (agent.runnerConfig.type) {
    case "claude": {
      const modelLabel = describeModelConfig(agent.runnerConfig.model);
      return modelLabel ? `claude · ${modelLabel}` : "claude";
    }
    default: {
      const modelLabel = describeModelConfig(agent.runnerConfig.model);
      return modelLabel ? `codex · ${modelLabel}` : "codex";
    }
  }
}

export function AgentCard({ agent, active = false, compact = false }: Props) {
  return (
    <article
      className={cn(
        "surface-card grid gap-3 p-5 text-left transition-[border-color,transform,background-color] hover:-translate-y-px",
        active
          ? "border-[rgba(113,112,255,0.38)] bg-[rgba(113,112,255,0.12)]"
          : "border-border"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex min-h-7 items-center rounded-full border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] tone-accent">
              Agent
            </span>
            <span className="inline-flex min-h-7 items-center rounded-full border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] tone-muted">
              {titleCase(agent.runnerConfig.type)}
            </span>
          </div>
          <h3 className="mt-3 m-0 text-[1.08rem] font-[590] leading-[1.3] tracking-[-0.03em]">
            {agent.name}
          </h3>
        </div>
      </div>

      {agent.description ? (
        <p
          className={cn(
            "m-0 text-[0.84rem] leading-[1.65] text-[var(--muted)]",
            compact && "[display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
          )}
        >
          {agent.description}
        </p>
      ) : null}

      <div className="grid gap-1 text-[0.74rem] text-[var(--muted)]">
        <span>Runner · {describeRunner(agent)}</span>
        <span>Updated {formatRelativeTime(agent.updatedAt)}</span>
      </div>
    </article>
  );
}
