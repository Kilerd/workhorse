import { useMemo, useState } from "react";
import type {
  AccountAgent,
  ClaudePermissionMode,
  ClaudeRunnerConfig,
  CodexRunnerConfig,
  CreateAgentBody,
  ModelConfig,
  ReasoningEffort,
  RunnerConfig,
  UpdateAgentBody
} from "@workhorse/contracts";
import {
  CLAUDE_BUILTIN_MODELS,
  CLAUDE_REASONING_EFFORTS,
  CODEX_BUILTIN_MODELS,
  CODEX_REASONING_EFFORTS
} from "@workhorse/contracts";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

type AgentFormPayload = Pick<CreateAgentBody, "name" | "description" | "runnerConfig">;

interface Props {
  mode: "create" | "edit";
  agent?: AccountAgent | null;
  submitting?: boolean;
  onSubmit(values: AgentFormPayload): Promise<void> | void;
  onDelete?(): Promise<void> | void;
}

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

interface EnvEntry {
  key: string;
  value: string;
}

function envRecordToEntries(env: Record<string, string> | undefined): EnvEntry[] {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

function entriesToEnvRecord(entries: EnvEntry[]): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) continue;
    record[key] = entry.value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function defaultBuiltinModel(runner: "claude" | "codex"): ModelConfig {
  const list = runner === "claude" ? CLAUDE_BUILTIN_MODELS : CODEX_BUILTIN_MODELS;
  return {
    mode: "builtin",
    id: list[0],
    reasoningEffort: "medium"
  };
}

export function createDefaultRunnerConfig(type: RunnerConfig["type"]): RunnerConfig {
  switch (type) {
    case "claude":
      return {
        type: "claude",
        prompt: "",
        permissionMode: "default",
        model: defaultBuiltinModel("claude")
      };
    default:
      return {
        type: "codex",
        prompt: "",
        approvalMode: "default",
        model: defaultBuiltinModel("codex")
      };
  }
}

function normalizeModelConfig(model: ModelConfig | undefined): ModelConfig | undefined {
  if (!model) return undefined;
  const id = model.id.trim();
  if (!id) return undefined;
  if (model.mode === "builtin") {
    return {
      mode: "builtin",
      id,
      reasoningEffort: model.reasoningEffort
    };
  }
  return { mode: "custom", id };
}

export function normalizeAgentPayload(input: AgentFormPayload): AgentFormPayload {
  const description = input.description?.trim() ?? "";

  if (input.runnerConfig.type === "claude") {
    const claude = input.runnerConfig;
    const model = normalizeModelConfig(claude.model);
    const env = claude.env
      ? entriesToEnvRecord(envRecordToEntries(claude.env))
      : undefined;
    return {
      name: input.name.trim(),
      description,
      runnerConfig: {
        type: "claude",
        prompt: claude.prompt,
        agent: claude.agent?.trim() || undefined,
        model,
        permissionMode: claude.permissionMode,
        ...(env ? { env } : {})
      }
    };
  }

  const codex = input.runnerConfig;
  const model = normalizeModelConfig(codex.model);
  return {
    name: input.name.trim(),
    description,
    runnerConfig: {
      type: "codex",
      prompt: codex.prompt,
      model,
      approvalMode: codex.approvalMode
    }
  };
}

export function validateAgentPayload(input: AgentFormPayload): string | null {
  if (!input.name.trim()) {
    return "Agent name is required.";
  }
  return null;
}

function resolveInitialPayload(agent: AccountAgent | null | undefined): AgentFormPayload {
  if (agent) {
    return {
      name: agent.name,
      description: agent.description ?? "",
      runnerConfig: agent.runnerConfig
    };
  }

  return {
    name: "",
    description: "",
    runnerConfig: createDefaultRunnerConfig("codex")
  };
}

interface ModelPickerProps {
  runner: "claude" | "codex";
  value: ModelConfig | undefined;
  onChange(next: ModelConfig | undefined): void;
}

function ModelPicker({ runner, value, onChange }: ModelPickerProps) {
  const builtinModels = runner === "claude" ? CLAUDE_BUILTIN_MODELS : CODEX_BUILTIN_MODELS;
  const reasoningEfforts = runner === "claude" ? CLAUDE_REASONING_EFFORTS : CODEX_REASONING_EFFORTS;
  const mode = value?.mode ?? "builtin";

  return (
    <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
      <label className="grid gap-1.5">
        <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
          Model source
        </span>
        <NativeSelect
          value={mode}
          onChange={(event) => {
            const nextMode = event.target.value as "builtin" | "custom";
            if (nextMode === "builtin") {
              onChange({
                mode: "builtin",
                id: builtinModels[0],
                reasoningEffort: "medium"
              });
            } else {
              onChange({ mode: "custom", id: value?.id ?? "" });
            }
          }}
        >
          <option value="builtin">builtin</option>
          <option value="custom">custom</option>
        </NativeSelect>
      </label>

      {mode === "builtin" ? (
        <>
          <label className="grid gap-1.5">
            <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
              Model
            </span>
            <NativeSelect
              value={value?.id ?? builtinModels[0]}
              onChange={(event) =>
                onChange({
                  mode: "builtin",
                  id: event.target.value,
                  reasoningEffort: value?.mode === "builtin" ? value.reasoningEffort : "medium"
                })
              }
            >
              {builtinModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1.5 md:col-span-2">
            <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
              Reasoning effort
            </span>
            <NativeSelect
              value={
                value?.mode === "builtin" && value.reasoningEffort
                  ? value.reasoningEffort
                  : "medium"
              }
              onChange={(event) =>
                onChange({
                  mode: "builtin",
                  id: value?.id ?? builtinModels[0],
                  reasoningEffort: event.target.value as ReasoningEffort
                })
              }
            >
              {reasoningEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </NativeSelect>
          </label>
        </>
      ) : (
        <label className="grid gap-1.5">
          <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
            Custom model id
          </span>
          <Input
            value={value?.id ?? ""}
            onChange={(event) => onChange({ mode: "custom", id: event.target.value })}
            placeholder={runner === "claude" ? "claude-sonnet-4-6" : "gpt-5.4"}
          />
        </label>
      )}
    </div>
  );
}

interface EnvEditorProps {
  entries: EnvEntry[];
  onChange(next: EnvEntry[]): void;
}

function EnvEditor({ entries, onChange }: EnvEditorProps) {
  return (
    <div className="grid gap-2 md:col-span-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
          Environment variables
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange([...entries, { key: "", value: "" }])}
        >
          + Add
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="m-0 text-[0.72rem] text-[var(--muted)]">
          No environment variables configured.
        </p>
      ) : (
        <div className="grid gap-2">
          {entries.map((entry, index) => (
            <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <Input
                value={entry.key}
                onChange={(event) => {
                  const next = entries.slice();
                  next[index] = { ...entry, key: event.target.value };
                  onChange(next);
                }}
                placeholder="KEY"
              />
              <Input
                value={entry.value}
                onChange={(event) => {
                  const next = entries.slice();
                  next[index] = { ...entry, value: event.target.value };
                  onChange(next);
                }}
                placeholder="value"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  const next = entries.slice();
                  next.splice(index, 1);
                  onChange(next);
                }}
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentForm({
  mode,
  agent,
  submitting = false,
  onSubmit,
  onDelete
}: Props) {
  const [payload, setPayload] = useState<AgentFormPayload>(() => resolveInitialPayload(agent));
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>(() => {
    const runner = resolveInitialPayload(agent).runnerConfig;
    if (runner.type === "claude") {
      return envRecordToEntries(runner.env);
    }
    return [];
  });
  const validationError = useMemo(() => validateAgentPayload(payload), [payload]);
  const submitLabel = mode === "create" ? "Create Agent" : "Save Agent";

  const updateRunner = <T extends RunnerConfig>(
    predicate: (cfg: RunnerConfig) => cfg is T,
    updater: (cfg: T) => T
  ) => {
    setPayload((current) => {
      if (!predicate(current.runnerConfig)) return current;
      return { ...current, runnerConfig: updater(current.runnerConfig) };
    });
  };

  const isClaude = (cfg: RunnerConfig): cfg is ClaudeRunnerConfig => cfg.type === "claude";
  const isCodex = (cfg: RunnerConfig): cfg is CodexRunnerConfig => cfg.type === "codex";

  const runnerType = payload.runnerConfig.type;
  const supportsEnv = runnerType === "claude";

  return (
    <form
      className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
      onSubmit={(event) => {
        event.preventDefault();
        if (validationError || submitting) {
          return;
        }

        let runnerConfig = payload.runnerConfig;
        const envRecord = entriesToEnvRecord(envEntries);
        if (runnerConfig.type === "claude") {
          runnerConfig = { ...runnerConfig, env: envRecord };
        }
        void Promise.resolve(
          onSubmit(normalizeAgentPayload({ ...payload, runnerConfig }))
        );
      }}
    >
      <div className="border-b border-border px-5 py-4 max-[720px]:px-4">
        <p className="m-0 font-mono text-[0.62rem] uppercase tracking-[0.14em] text-[var(--accent)]">
          {mode === "create" ? "Create Agent" : "Edit Agent"}
        </p>
        <h2 className="m-0 mt-1 text-[1rem] font-semibold">
          {mode === "create" ? "Configure an account-level agent" : agent?.name ?? "Agent"}
        </h2>
      </div>

      <div className="grid min-h-0 content-start gap-4 overflow-y-auto px-5 py-4 max-[720px]:px-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent)]">
              Agent name
            </span>
            <Input
              value={payload.name}
              onChange={(event) =>
                setPayload((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="Frontend Coordinator"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent)]">
              Runner
            </span>
            <NativeSelect
              value={payload.runnerConfig.type}
              onChange={(event) => {
                const nextType = event.target.value as RunnerConfig["type"];
                setPayload((current) => ({
                  ...current,
                  runnerConfig: createDefaultRunnerConfig(nextType)
                }));
                setEnvEntries([]);
              }}
            >
              <option value="codex">codex</option>
              <option value="claude">claude</option>
            </NativeSelect>
          </label>

          <label className="grid gap-1.5 md:col-span-2">
            <span className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--accent)]">
              Description (agent instruction)
            </span>
            <Textarea
              rows={5}
              value={payload.description ?? ""}
              onChange={(event) =>
                setPayload((current) => ({
                  ...current,
                  description: event.target.value
                }))
              }
              placeholder="Describe what this agent is optimized for. This text is injected as the agent instruction."
            />
          </label>

          {payload.runnerConfig.type === "codex" ? (
            <>
              <ModelPicker
                runner="codex"
                value={payload.runnerConfig.model}
                onChange={(model) => updateRunner(isCodex, (cfg) => ({ ...cfg, model }))}
              />
              <label className="grid gap-1.5 md:col-span-2">
                <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                  Approval mode
                </span>
                <NativeSelect
                  value={payload.runnerConfig.approvalMode ?? "default"}
                  onChange={(event) =>
                    updateRunner(isCodex, (cfg) => ({
                      ...cfg,
                      approvalMode: event.target.value as "default" | "auto"
                    }))
                  }
                >
                  <option value="default">default</option>
                  <option value="auto">auto</option>
                </NativeSelect>
              </label>
            </>
          ) : null}

          {payload.runnerConfig.type === "claude" ? (
            <>
              <label className="grid gap-1.5">
                <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                  Claude agent
                </span>
                <Input
                  value={payload.runnerConfig.agent ?? ""}
                  onChange={(event) =>
                    updateRunner(isClaude, (cfg) => ({ ...cfg, agent: event.target.value }))
                  }
                  placeholder="code-reviewer"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--accent)]">
                  Permission mode
                </span>
                <NativeSelect
                  value={payload.runnerConfig.permissionMode ?? "default"}
                  onChange={(event) =>
                    updateRunner(isClaude, (cfg) => ({
                      ...cfg,
                      permissionMode: event.target.value as ClaudePermissionMode
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
              <ModelPicker
                runner="claude"
                value={payload.runnerConfig.model}
                onChange={(model) => updateRunner(isClaude, (cfg) => ({ ...cfg, model }))}
              />
            </>
          ) : null}

          {supportsEnv ? <EnvEditor entries={envEntries} onChange={setEnvEntries} /> : null}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-border px-5 py-4 max-[720px]:px-4">
        {validationError ? (
          <p className="mr-auto m-0 text-[0.72rem] text-[var(--danger)]">{validationError}</p>
        ) : (
          <p className="mr-auto m-0 text-[0.72rem] text-[var(--muted)]">
            Account agents can be mounted into any workspace as coordinators or workers; workspace instructions describe coding, planning, or review responsibilities.
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

export type { AgentFormPayload };
export type AgentUpdatePayload = Pick<UpdateAgentBody, "name" | "description" | "runnerConfig">;
