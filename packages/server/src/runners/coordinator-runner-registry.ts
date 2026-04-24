import type { AccountAgent, RunnerType } from "@workhorse/contracts";

import type { CoordinatorRunner } from "./session-bridge.js";

/**
 * Resolves the CoordinatorRunner used to drive a given agent's session.
 *
 * The Orchestrator owns one long-lived session per thread, but different
 * threads may be bound to different coordinator agents — each with its own
 * runner backend (claude-cli, codex-acp, shell …). The registry picks the
 * adapter by `AccountAgent.runnerConfig.type`, falling back to an opaque
 * default when the configured type has no bound adapter.
 */
export class CoordinatorRunnerRegistry {
  private readonly byType = new Map<RunnerType, CoordinatorRunner>();

  public constructor(private readonly fallback: CoordinatorRunner) {}

  public register(type: RunnerType, runner: CoordinatorRunner): void {
    this.byType.set(type, runner);
  }

  public resolve(agent: AccountAgent): CoordinatorRunner {
    const type = agent.runnerConfig.type;
    return this.byType.get(type) ?? this.fallback;
  }
}
