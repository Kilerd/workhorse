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
    case "shell":
      return agent.runnerConfig.command;
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
        "grid gap-3 rounded-[var(--radius-lg)] border bg-[var(--panel)] p-4 text-left",
        active ? "border-[var(--accent)] bg-[rgba(255,79,0,0.05)]" : "border-border"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex min-h-7 items-center rounded-full border border-[rgba(255,79,0,0.24)] bg-[rgba(255,79,0,0.08)] px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--accent-strong)]">
              Agent
            </span>
            <span className="inline-flex min-h-7 items-center rounded-full border border-border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--muted)]">
              {titleCase(agent.runnerConfig.type)}
            </span>
          </div>
          <h3 className="mt-3 m-0 text-[1rem] font-semibold leading-[1.35]">
            {agent.name}
          </h3>
        </div>
      </div>

      {agent.description ? (
        <p
          className={cn(
            "m-0 text-[0.86rem] leading-[1.6] text-[var(--muted)]",
            compact && "[display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
          )}
        >
          {agent.description}
        </p>
      ) : null}

      <div className="grid gap-1 text-[0.76rem] text-[var(--muted)]">
        <span>Runner · {describeRunner(agent)}</span>
        <span>Updated {formatRelativeTime(agent.updatedAt)}</span>
      </div>
    </article>
  );
}
