import { useEffect, useMemo, useState } from "react";
import type {
  AgentRole,
  AgentTeam,
  ClaudePermissionMode,
  CreateTeamBody,
  RunnerConfig,
  TeamAgent,
  TeamPrStrategy,
  UpdateTeamBody,
  Workspace
} from "@workhorse/contracts";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type TeamFormPayload = Pick<CreateTeamBody, "name" | "description" | "workspaceId" | "prStrategy" | "agents">;

interface Props {
  mode: "create" | "edit";
  team?: AgentTeam | null;
  workspaces: Workspace[];
  defaultWorkspaceId?: string;
  submitting?: boolean;
  onSubmit(values: TeamFormPayload): Promise<void> | void;
  onDelete?(): Promise<void> | void;
}

const DEFAULT_CODEX_PROMPT = "Coordinate implementation work and report concrete results.";
const DEFAULT_CLAUDE_PROMPT = "Review the current task, make the required changes, and summarize the outcome.";
const DEFAULT_SHELL_COMMAND = "npm test";

const CLAUDE_PERMISSION_OPTIONS: Array<{
  value: ClaudePermissionMode;
  label: string;
}> = [
  { value: "default", label: "default" },
  { value: "acceptEdits", label: "acceptEdits" },
  { value: "bypassPermissions", label: "bypassPermissions" },
  { value: "dontAsk", label: "dontAsk" },
  { value: "plan", label: "plan" }
];

function createDraftAgentId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `agent-${Math.random().toString(36).slice(2, 10)}`;
}

function createDefaultRunnerConfig(type: RunnerConfig["type"]): RunnerConfig {
  switch (type) {
    case "shell":
      return { type: "shell", command: DEFAULT_SHELL_COMMAND };
    case "claude":
      return { type: "claude", prompt: DEFAULT_CLAUDE_PROMPT, permissionMode: "default" };
    default:
      return { type: "codex", prompt: DEFAULT_CODEX_PROMPT, approvalMode: "default" };
  }
}

function createDefaultAgent(role: AgentRole = "worker"): TeamAgent {
  return {
    id: createDraftAgentId(),
    agentName: role === "coordinator" ? "Coordinator" : "Worker",
    role,
    runnerConfig: createDefaultRunnerConfig("codex")
  };
}

function normalizeTeamPayload(input: TeamFormPayload): TeamFormPayload {
  return {
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    workspaceId: input.workspaceId,
    prStrategy: input.prStrategy,
    agents: input.agents.map((agent) => ({
      ...agent,
      agentName: agent.agentName.trim(),
      runnerConfig:
        agent.runnerConfig.type === "shell"
          ? {
              type: "shell",
              command: agent.runnerConfig.command.trim()
            }
          : agent.runnerConfig.type === "claude"
            ? {
                type: "claude",
                prompt: agent.runnerConfig.prompt.trim(),
                agent: agent.runnerConfig.agent?.trim() || undefined,
                model: agent.runnerConfig.model?.trim() || undefined,
                permissionMode: agent.runnerConfig.permissionMode
              }
            : {
                type: "codex",
                prompt: agent.runnerConfig.prompt.trim(),
                model: agent.runnerConfig.model?.trim() || undefined,
                approvalMode: agent.runnerConfig.approvalMode
              }
    }))
  };
}

function resolveInitialPayload(
  team: AgentTeam | null | undefined,
  defaultWorkspaceId: string | undefined
): TeamFormPayload {
  if (team) {
    return {
      name: team.name,
      description: team.description,
      workspaceId: team.workspaceId,
      prStrategy: team.prStrategy,
      agents: team.agents
    };
  }

  return {
    name: "",
    description: "",
    workspaceId: defaultWorkspaceId ?? "",
    prStrategy: "independent",
    agents: [createDefaultAgent("coordinator"), createDefaultAgent("worker")]
  };
}

function validatePayload(input: TeamFormPayload): string | null {
  if (!input.name.trim()) {
    return "Team name is required.";
  }
  if (!input.workspaceId) {
    return "Workspace is required.";
  }
  if (input.agents.length === 0) {
    return "Add at least one agent.";
  }
  const coordinators = input.agents.filter((agent) => agent.role === "coordinator");
  if (coordinators.length !== 1) {
    return `Exactly 1 coordinator is required. Current count: ${coordinators.length}.`;
  }
  const invalidAgent = input.agents.find((agent) => {
    if (!agent.agentName.trim()) {
      return true;
    }
    if (agent.runnerConfig.type === "shell") {
      return !agent.runnerConfig.command.trim();
    }
    return !agent.runnerConfig.prompt.trim();
  });
  if (invalidAgent) {
    return "Every agent needs a name and a valid runner configuration.";
  }
  return null;
}

export function TeamForm({
  mode,
  team,
  workspaces,
  defaultWorkspaceId,
  submitting = false,
  onSubmit,
  onDelete
}: Props) {
  const [payload, setPayload] = useState<TeamFormPayload>(() =>
    resolveInitialPayload(team, defaultWorkspaceId)
  );

  useEffect(() => {
    setPayload(resolveInitialPayload(team, defaultWorkspaceId));
  }, [defaultWorkspaceId, team]);

  const validationError = useMemo(() => validatePayload(payload), [payload]);
  const submitLabel = mode === "create" ? "Create Team" : "Save Team";

  return (
    <form
      className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
      onSubmit={(event) => {
        event.preventDefault();
        if (validationError || submitting) {
          return;
        }
        void Promise.resolve(onSubmit(normalizeTeamPayload(payload)));
      }}
    >
      <div className="border-b border-border px-5 py-4 max-[720px]:px-4">
        <p className="m-0 font-mono text-[0.62rem] uppercase tracking-[0.14em] text-[var(--accent)]">
          {mode === "create" ? "Create Team" : "Edit Team"}
        </p>
        <h2 className="m-0 mt-1 text-[1rem] font-semibold">
          {mode === "create" ? "Configure an agent team" : team?.name ?? "Team"}
        </h2>
      </div>

      <div className="grid min-h-0 content-start gap-4 overflow-y-auto px-5 py-4 max-[720px]:px-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent)]">
              Team name
            </span>
            <Input
              value={payload.name}
              onChange={(event) =>
                setPayload((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="Platform Delivery"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent)]">
              Workspace
            </span>
            <NativeSelect
              value={payload.workspaceId}
              disabled={mode === "edit"}
              onChange={(event) =>
                setPayload((current) => ({ ...current, workspaceId: event.target.value }))
              }
            >
              <option value="" disabled>
                Select workspace
              </option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </NativeSelect>
            {mode === "edit" ? (
              <p className="m-0 text-[0.68rem] text-[var(--muted)]">
                Workspace is fixed after team creation.
              </p>
            ) : null}
          </label>

          <label className="grid gap-1.5 md:col-span-2">
            <span className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent)]">
              Description
            </span>
            <Textarea
              rows={3}
              value={payload.description ?? ""}
              onChange={(event) =>
                setPayload((current) => ({
                  ...current,
                  description: event.target.value
                }))
              }
              placeholder="Describe what this team owns."
            />
          </label>

          <label className="grid gap-1.5">
            <span className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent)]">
              PR strategy
            </span>
            <NativeSelect
              value={payload.prStrategy ?? "independent"}
              onChange={(event) =>
                setPayload((current) => ({
                  ...current,
                  prStrategy: event.target.value as TeamPrStrategy
                }))
              }
            >
              <option value="independent">independent</option>
            </NativeSelect>
            <p className="m-0 text-[0.68rem] text-[var(--muted)]">
              Initial UI only exposes the independent strategy.
            </p>
          </label>
        </div>

        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="m-0 font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                Agents
              </p>
              <p className="m-0 mt-1 text-[0.7rem] text-[var(--muted)]">
                Exactly one coordinator is required.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setPayload((current) => ({
                  ...current,
                  agents: [...current.agents, createDefaultAgent("worker")]
                }))
              }
            >
              Add Agent
            </Button>
          </div>

          <div className="grid gap-3">
            {payload.agents.map((agent, index) => (
              <div key={agent.id} className="grid gap-3 border border-border bg-[var(--panel)] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[0.62rem] uppercase tracking-[0.12em] text-[var(--muted)]">
                      Agent {index + 1}
                    </span>
                    <span className={cn(
                      "inline-flex min-h-5 items-center rounded-none border px-1.5 font-mono text-[0.56rem] uppercase tracking-[0.1em]",
                      agent.role === "coordinator"
                        ? "border-[rgba(73,214,196,0.28)] bg-[rgba(73,214,196,0.12)] text-[var(--accent-strong)]"
                        : "border-[rgba(104,199,246,0.24)] bg-[rgba(104,199,246,0.12)] text-[var(--info)]"
                    )}>
                      {agent.role}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={payload.agents.length <= 1}
                    onClick={() =>
                      setPayload((current) => ({
                        ...current,
                        agents: current.agents.filter((entry) => entry.id !== agent.id)
                      }))
                    }
                  >
                    Remove
                  </Button>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <label className="grid gap-1.5">
                    <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                      Agent name
                    </span>
                    <Input
                      value={agent.agentName}
                      onChange={(event) =>
                        setPayload((current) => ({
                          ...current,
                          agents: current.agents.map((entry) =>
                            entry.id === agent.id
                              ? { ...entry, agentName: event.target.value }
                              : entry
                          )
                        }))
                      }
                      placeholder="Worker-B"
                    />
                  </label>

                  <label className="grid gap-1.5">
                    <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                      Role
                    </span>
                    <NativeSelect
                      value={agent.role}
                      onChange={(event) =>
                        setPayload((current) => ({
                          ...current,
                          agents: current.agents.map((entry) =>
                            entry.id === agent.id
                              ? { ...entry, role: event.target.value as AgentRole }
                              : entry
                          )
                        }))
                      }
                    >
                      <option value="coordinator">coordinator</option>
                      <option value="worker">worker</option>
                    </NativeSelect>
                  </label>

                  <label className="grid gap-1.5">
                    <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                      Runner
                    </span>
                    <NativeSelect
                      value={agent.runnerConfig.type}
                      onChange={(event) =>
                        setPayload((current) => ({
                          ...current,
                          agents: current.agents.map((entry) =>
                            entry.id === agent.id
                              ? {
                                  ...entry,
                                  runnerConfig: createDefaultRunnerConfig(
                                    event.target.value as RunnerConfig["type"]
                                  )
                                }
                              : entry
                          )
                        }))
                      }
                    >
                      <option value="codex">codex</option>
                      <option value="claude">claude</option>
                      <option value="shell">shell</option>
                    </NativeSelect>
                  </label>

                  {agent.runnerConfig.type === "shell" ? (
                    <label className="grid gap-1.5 md:col-span-2">
                      <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                        Command
                      </span>
                      <Input
                        value={agent.runnerConfig.command}
                        onChange={(event) =>
                          setPayload((current) => ({
                            ...current,
                            agents: current.agents.map((entry) =>
                              entry.id === agent.id &&
                              entry.runnerConfig.type === "shell"
                                ? {
                                    ...entry,
                                    runnerConfig: {
                                      ...entry.runnerConfig,
                                      command: event.target.value
                                    }
                                  }
                                : entry
                            )
                          }))
                        }
                        placeholder="npm test"
                      />
                    </label>
                  ) : (
                    <>
                      <label className="grid gap-1.5 md:col-span-2">
                        <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                          Prompt
                        </span>
                        <Textarea
                          rows={4}
                          value={agent.runnerConfig.prompt}
                          onChange={(event) =>
                            setPayload((current) => ({
                              ...current,
                              agents: current.agents.map((entry) =>
                                entry.id === agent.id &&
                                entry.runnerConfig.type !== "shell"
                                  ? {
                                      ...entry,
                                      runnerConfig: {
                                        ...entry.runnerConfig,
                                        prompt: event.target.value
                                      }
                                    }
                                  : entry
                              )
                            }))
                          }
                        />
                      </label>

                      {agent.runnerConfig.type === "codex" ? (
                        <>
                          <label className="grid gap-1.5">
                            <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                              Model override
                            </span>
                            <Input
                              value={agent.runnerConfig.model ?? ""}
                              onChange={(event) =>
                                setPayload((current) => ({
                                  ...current,
                                  agents: current.agents.map((entry) =>
                                    entry.id === agent.id &&
                                    entry.runnerConfig.type === "codex"
                                      ? {
                                          ...entry,
                                          runnerConfig: {
                                            ...entry.runnerConfig,
                                            model: event.target.value
                                          }
                                        }
                                      : entry
                                  )
                                }))
                              }
                              placeholder="gpt-5.4"
                            />
                          </label>
                          <label className="grid gap-1.5">
                            <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                              Approval mode
                            </span>
                            <NativeSelect
                              value={agent.runnerConfig.approvalMode ?? "default"}
                              onChange={(event) =>
                                setPayload((current) => ({
                                  ...current,
                                  agents: current.agents.map((entry) =>
                                    entry.id === agent.id &&
                                    entry.runnerConfig.type === "codex"
                                      ? {
                                          ...entry,
                                          runnerConfig: {
                                            ...entry.runnerConfig,
                                            approvalMode: event.target.value as "default" | "auto"
                                          }
                                        }
                                      : entry
                                  )
                                }))
                              }
                            >
                              <option value="default">default</option>
                              <option value="auto">auto</option>
                            </NativeSelect>
                          </label>
                        </>
                      ) : (
                        <>
                          <label className="grid gap-1.5">
                            <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                              Claude agent
                            </span>
                            <Input
                              value={agent.runnerConfig.agent ?? ""}
                              onChange={(event) =>
                                setPayload((current) => ({
                                  ...current,
                                  agents: current.agents.map((entry) =>
                                    entry.id === agent.id &&
                                    entry.runnerConfig.type === "claude"
                                      ? {
                                          ...entry,
                                          runnerConfig: {
                                            ...entry.runnerConfig,
                                            agent: event.target.value
                                          }
                                        }
                                      : entry
                                  )
                                }))
                              }
                              placeholder="code-reviewer"
                            />
                          </label>
                          <label className="grid gap-1.5">
                            <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                              Model override
                            </span>
                            <Input
                              value={agent.runnerConfig.model ?? ""}
                              onChange={(event) =>
                                setPayload((current) => ({
                                  ...current,
                                  agents: current.agents.map((entry) =>
                                    entry.id === agent.id &&
                                    entry.runnerConfig.type === "claude"
                                      ? {
                                          ...entry,
                                          runnerConfig: {
                                            ...entry.runnerConfig,
                                            model: event.target.value
                                          }
                                        }
                                      : entry
                                  )
                                }))
                              }
                              placeholder="claude-sonnet-4-6"
                            />
                          </label>
                          <label className="grid gap-1.5 md:col-span-2">
                            <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                              Permission mode
                            </span>
                            <NativeSelect
                              value={agent.runnerConfig.permissionMode ?? "default"}
                              onChange={(event) =>
                                setPayload((current) => ({
                                  ...current,
                                  agents: current.agents.map((entry) =>
                                    entry.id === agent.id &&
                                    entry.runnerConfig.type === "claude"
                                      ? {
                                          ...entry,
                                          runnerConfig: {
                                            ...entry.runnerConfig,
                                            permissionMode: event.target.value as ClaudePermissionMode
                                          }
                                        }
                                      : entry
                                  )
                                }))
                              }
                            >
                              {CLAUDE_PERMISSION_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </NativeSelect>
                          </label>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-border px-5 py-4 max-[720px]:px-4">
        {validationError ? (
          <p className="mr-auto m-0 text-[0.72rem] text-[var(--danger)]">
            {validationError}
          </p>
        ) : (
          <p className="mr-auto m-0 text-[0.72rem] text-[var(--muted)]">
            Team tasks will inherit the coordinator runner automatically.
          </p>
        )}
        {mode === "edit" && onDelete ? (
          <Button
            type="button"
            variant="destructive"
            onClick={() => void Promise.resolve(onDelete())}
            disabled={submitting}
          >
            Delete
          </Button>
        ) : null}
        <Button type="submit" disabled={Boolean(validationError) || submitting}>
          {submitting ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}
