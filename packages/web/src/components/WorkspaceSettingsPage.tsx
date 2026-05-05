import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bot,
  Crown,
  Plus,
  Users
} from "lucide-react";
import type {
  ModelConfig,
  RunnerConfig,
  Workspace,
  WorkspaceAgent,
  WorkspaceCodexSettings,
  WorkspacePromptTemplateId,
  WorkspacePromptTemplates
} from "@workhorse/contracts";
import {
  DEFAULT_WORKSPACE_PROMPT_TEMPLATES,
  previewTemplate,
  WORKSPACE_PROMPT_TEMPLATE_DEFINITIONS,
  WORKSPACE_PROMPT_TEMPLATE_IDS
} from "@workhorse/contracts";

import {
  createWorkspacePromptTemplateState,
  EMPTY_WORKSPACE_PROMPT_TEMPLATES,
  serializeWorkspacePromptTemplates
} from "@/lib/workspace-prompt-templates";
import { countWorkspaceWorkers, getCoordinatorWorkspaceAgent } from "@/lib/coordination";
import { readErrorMessage } from "@/lib/error-message";
import { formatCount, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { useAgents, useWorkspaceAgentMutations, useWorkspaceAgents } from "@/hooks/useAgents";
import { WorkspaceContextPanel } from "@/components/WorkspaceContextPanel";

// ---------------------------------------------------------------------------
// Tab definition
// ---------------------------------------------------------------------------

type TabId = "general" | "agents" | "context" | WorkspacePromptTemplateId;

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "context", label: "Context" },
  ...WORKSPACE_PROMPT_TEMPLATE_IDS.map((id) => ({
    id: id as TabId,
    label: WORKSPACE_PROMPT_TEMPLATE_DEFINITIONS[id].label
  }))
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const APPROVAL_POLICY_OPTIONS: Array<{
  value: WorkspaceCodexSettings["approvalPolicy"];
  label: string;
  hint: string;
}> = [
  { value: "untrusted", label: "untrusted", hint: "Ask before running commands outside the trusted set." },
  { value: "on-request", label: "on-request", hint: "Let Codex decide when to ask for approval." },
  { value: "on-failure", label: "on-failure", hint: "Run first, escalate only after a sandbox failure." },
  { value: "never", label: "never", hint: "Never ask for approval." }
];

const SANDBOX_MODE_OPTIONS: Array<{
  value: WorkspaceCodexSettings["sandboxMode"];
  label: string;
  hint: string;
}> = [
  { value: "read-only", label: "read-only", hint: "Inspect files without modifying the workspace." },
  { value: "workspace-write", label: "workspace-write", hint: "Allow edits inside the workspace." },
  { value: "danger-full-access", label: "danger-full-access", hint: "Bypass sandbox protections completely." }
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface Props {
  workspace: Workspace | null;
  taskCount: number;
  onSubmit(values: {
    name: string;
    codexSettings: WorkspaceCodexSettings;
    promptTemplates?: WorkspacePromptTemplates;
  }): Promise<void> | void;
}

export function WorkspaceSettingsPage({ workspace, taskCount, onSubmit }: Props) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [approvalPolicy, setApprovalPolicy] =
    useState<WorkspaceCodexSettings["approvalPolicy"]>("on-request");
  const [sandboxMode, setSandboxMode] =
    useState<WorkspaceCodexSettings["sandboxMode"]>("workspace-write");
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [promptTemplates, setPromptTemplates] = useState(EMPTY_WORKSPACE_PROMPT_TEMPLATES);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    setName(workspace.name);
    setApprovalPolicy(workspace.codexSettings.approvalPolicy);
    setSandboxMode(workspace.codexSettings.sandboxMode);
    setPromptTemplates(createWorkspacePromptTemplateState(workspace.promptTemplates));
  }, [workspace]);

  if (!workspace) {
    return (
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <PageHeader onBack={() => navigate("/")} title="Workspace Settings" />
        <div className="flex items-center justify-center p-10 text-[0.9rem] text-[var(--muted)]">
          Select a workspace first.
        </div>
      </div>
    );
  }

  const canSubmit = Boolean(name.trim());
  const activePromptTemplateId: WorkspacePromptTemplateId =
    activeTab === "general" || activeTab === "agents" || activeTab === "context"
      ? WORKSPACE_PROMPT_TEMPLATE_IDS[0]
      : activeTab;

  return (
    <div className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden">
      <PageHeader onBack={() => navigate("/")} title={workspace.name} />

      {/* Tab bar */}
      <div className="flex gap-0 overflow-x-auto border-b border-border px-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={cn(
              "shrink-0 border-b-2 px-3 py-2.5 text-[0.82rem] font-medium transition-colors",
              activeTab === tab.id
                ? "border-foreground text-foreground"
                : "border-transparent text-[var(--muted)] hover:text-foreground"
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="overflow-y-auto">
        <div className="px-4 py-3.5">
          {activeTab === "general" ? (
            <GeneralTab
              name={name}
              onNameChange={setName}
              approvalPolicy={approvalPolicy}
              onApprovalPolicyChange={setApprovalPolicy}
              sandboxMode={sandboxMode}
              onSandboxModeChange={setSandboxMode}
              workspace={workspace}
              taskCount={taskCount}
            />
          ) : activeTab === "agents" ? (
            <AgentsTab workspace={workspace} />
          ) : activeTab === "context" ? (
            <WorkspaceContextPanel workspace={workspace} active={activeTab === "context"} />
          ) : (
            <PromptTab
              templateId={activePromptTemplateId}
              value={promptTemplates[activePromptTemplateId]}
              showPreview={showPreview}
              onChange={(v) =>
                setPromptTemplates((cur) => ({ ...cur, [activePromptTemplateId]: v }))
              }
              onLoadDefault={() =>
                setPromptTemplates((cur) => ({
                  ...cur,
                  [activePromptTemplateId]:
                    DEFAULT_WORKSPACE_PROMPT_TEMPLATES[activePromptTemplateId]
                }))
              }
              onClear={() =>
                setPromptTemplates((cur) => ({ ...cur, [activePromptTemplateId]: "" }))
              }
              onTogglePreview={() => setShowPreview((v) => !v)}
            />
          )}

          {activeTab !== "agents" && activeTab !== "context" ? (
            <div className="pt-4">
              <Button
                type="button"
                size="sm"
                disabled={!canSubmit}
                onClick={() =>
                  onSubmit({
                    name,
                    codexSettings: { approvalPolicy, sandboxMode },
                    promptTemplates: serializeWorkspacePromptTemplates(promptTemplates)
                  })
                }
              >
                Save
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PageHeader({
  onBack,
  title,
  actions
}: {
  onBack(): void;
  title: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
      <div className="flex items-center gap-3">
        <Button type="button" variant="secondary" size="sm" onClick={onBack}>
          Back
        </Button>
        <h1 className="m-0 text-[1.2rem] font-semibold">{title}</h1>
      </div>
      {actions}
    </div>
  );
}

function CopyToken({ token }: { token: string }) {
  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(token);
      toast({
        title: "Token copied",
        description: "Workspace prompt token copied to clipboard."
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Copy failed",
        description: readErrorMessage(error, "Unable to copy token to clipboard.")
      });
    }
  }, [token]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="shrink-0 cursor-pointer rounded bg-transparent font-mono text-[0.68rem] text-[var(--accent-strong)] transition-colors hover:text-foreground"
      title="Click to copy"
    >
      {token}
    </button>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[0.82rem] font-medium text-[var(--muted)]">{label}</span>
      {children}
      {hint ? <span className="text-[0.76rem] text-[var(--muted)]">{hint}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// General tab
// ---------------------------------------------------------------------------

function GeneralTab({
  name,
  onNameChange,
  approvalPolicy,
  onApprovalPolicyChange,
  sandboxMode,
  onSandboxModeChange,
  workspace,
  taskCount
}: {
  name: string;
  onNameChange(v: string): void;
  approvalPolicy: WorkspaceCodexSettings["approvalPolicy"];
  onApprovalPolicyChange(v: WorkspaceCodexSettings["approvalPolicy"]): void;
  sandboxMode: WorkspaceCodexSettings["sandboxMode"];
  onSandboxModeChange(v: WorkspaceCodexSettings["sandboxMode"]): void;
  workspace: Workspace;
  taskCount: number;
}) {
  const approvalHint =
    APPROVAL_POLICY_OPTIONS.find((o) => o.value === approvalPolicy)?.hint ?? "";
  const sandboxHint =
    SANDBOX_MODE_OPTIONS.find((o) => o.value === sandboxMode)?.hint ?? "";

  return (
    <div className="grid gap-4">
      <Field label="Name">
        <Input className="max-w-xs" value={name} onChange={(e) => onNameChange(e.target.value)} />
      </Field>

      <div className="grid gap-1 text-[0.82rem] text-[var(--muted)]">
        <span><code>{workspace.rootPath}</code></span>
        <span>
          {workspace.isGitRepo ? "Git repository" : "Non-Git directory"}
          {" · "}
          {taskCount} {taskCount === 1 ? "task" : "tasks"}
        </span>
      </div>

      <hr className="border-border" />

      <Field label="Approval policy" hint={approvalHint}>
        <NativeSelect
          className="max-w-xs"
          value={approvalPolicy}
          onChange={(e) =>
            onApprovalPolicyChange(e.target.value as WorkspaceCodexSettings["approvalPolicy"])
          }
        >
          {APPROVAL_POLICY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </NativeSelect>
      </Field>

      <Field label="Sandbox mode" hint={sandboxHint}>
        <NativeSelect
          className="max-w-xs"
          value={sandboxMode}
          onChange={(e) =>
            onSandboxModeChange(e.target.value as WorkspaceCodexSettings["sandboxMode"])
          }
        >
          {SANDBOX_MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </NativeSelect>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompt template tab
// ---------------------------------------------------------------------------

function PromptTab({
  templateId,
  value,
  showPreview,
  onChange,
  onLoadDefault,
  onClear,
  onTogglePreview
}: {
  templateId: WorkspacePromptTemplateId;
  value: string;
  showPreview: boolean;
  onChange(v: string): void;
  onLoadDefault(): void;
  onClear(): void;
  onTogglePreview(): void;
}) {
  const definition = WORKSPACE_PROMPT_TEMPLATE_DEFINITIONS[templateId];
  const hasCustom = Boolean(value.trim());

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-[0.82rem] text-[var(--muted)]">{definition.description}</p>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onLoadDefault}>
            Load built-in
          </Button>
          {hasCustom ? (
            <Button type="button" variant="secondary" size="sm" onClick={onClear}>
              Clear
            </Button>
          ) : null}
          <Button type="button" variant="secondary" size="sm" onClick={onTogglePreview}>
            {showPreview ? "Hide preview" : "Preview"}
          </Button>
        </div>
      </div>

      <div className={cn("grid gap-4", showPreview && "lg:grid-cols-2")}>
        <Textarea
          rows={16}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={definition.defaultTemplate}
          className="font-mono text-[0.72rem] leading-[1.65]"
        />
        {showPreview ? (
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius)] border border-border bg-[var(--surface-faint)] p-3 font-mono text-[0.68rem] leading-[1.7] text-foreground">
            {previewTemplate(templateId, value)}
          </pre>
        ) : null}
      </div>

      <details>
        <summary className="cursor-pointer text-[0.78rem] font-medium text-[var(--muted)] transition-colors hover:text-foreground">
          Available variables
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {definition.variables.map((variable) => (
            <div key={variable.key} className="flex items-baseline gap-2 text-[0.76rem]">
              <CopyToken token={variable.token} />
              <span className="text-[var(--muted)]">{variable.description}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
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

function describeRunnerConfig(config: RunnerConfig): { label: string; detail: string } {
  switch (config.type) {
    case "claude": {
      const detail = [
        config.agent?.trim() ? `agent ${config.agent.trim()}` : null,
        describeModelConfig(config.model) ?? "local default model",
        config.permissionMode ? `permissions ${config.permissionMode}` : null
      ]
        .filter(Boolean)
        .join(" · ");

      return {
        label: "Claude runner",
        detail
      };
    }
    case "codex": {
      const detail = [
        describeModelConfig(config.model) ?? "local default model",
        config.approvalMode ? `approval ${config.approvalMode}` : null
      ]
        .filter(Boolean)
        .join(" · ");

      return {
        label: "Codex runner",
        detail
      };
    }
  }
}

function MetricCard({
  icon: Icon,
  label,
  value,
  hint,
  accent = false
}: {
  icon: typeof Bot;
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 rounded-[var(--radius-lg)] border p-4",
        accent
          ? "border-[rgba(113,112,255,0.28)] bg-[rgba(113,112,255,0.1)]"
          : "border-border bg-[var(--panel)]"
      )}
    >
      <div className="flex items-center gap-2 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
        <span
          className={cn(
            "grid size-8 place-items-center rounded-full border",
            accent
              ? "tone-accent"
              : "tone-muted"
          )}
        >
          <Icon className="size-4" />
        </span>
        {label}
      </div>
      <div className="grid gap-1">
        <span className="text-[1.05rem] font-semibold leading-none text-foreground">{value}</span>
        <span className="text-[0.78rem] leading-[1.55] text-[var(--muted)]">{hint}</span>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: WorkspaceAgent["role"] }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center rounded-full border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em]",
        role === "coordinator"
          ? "tone-accent"
          : "tone-info"
      )}
    >
      {titleCase(role)}
    </span>
  );
}

function AgentsTab({
  workspace
}: {
  workspace: Workspace;
}) {
  const navigate = useNavigate();
  const agentsQuery = useAgents();
  const workspaceAgentsQuery = useWorkspaceAgents(workspace.id);
  const mutations = useWorkspaceAgentMutations(workspace.id);
  const [workspaceDescriptionDrafts, setWorkspaceDescriptionDrafts] = useState<
    Record<string, string>
  >({});

  const agents = agentsQuery.data ?? [];
  const mountedAgents = workspaceAgentsQuery.data ?? [];
  const coordinator = getCoordinatorWorkspaceAgent(mountedAgents);
  const availableAgents = agents.filter(
    (agent) => !mountedAgents.some((entry) => entry.id === agent.id)
  );
  const agentsLoadError = agentsQuery.error
    ? readErrorMessage(agentsQuery.error, "Failed to load account agents.")
    : null;
  const mountedAgentsLoadError = workspaceAgentsQuery.error
    ? readErrorMessage(workspaceAgentsQuery.error, "Failed to load mounted workspace agents.")
    : null;

  const mountAgent = (agentId: string, role: WorkspaceAgent["role"], agentName: string) => {
    void mutations
      .mount({ agentId, role, workspaceDescription: "" })
      .then(() => {
        toast({
          title: "Agent mounted",
          description: `${agentName} is now available in ${workspace.name} as ${role}.`
        });
      })
      .catch((nextError) => {
        toast({
          variant: "destructive",
          title: "Couldn't mount agent",
          description: readErrorMessage(nextError, "Failed to mount workspace agent.")
        });
      });
  };

  useEffect(() => {
    const nextMountedAgents = workspaceAgentsQuery.data ?? [];
    setWorkspaceDescriptionDrafts(
      Object.fromEntries(
        nextMountedAgents.map((agent) => [agent.id, agent.workspaceDescription ?? ""])
      )
    );
  }, [workspaceAgentsQuery.data]);

  const mountedWorkerCount = countWorkspaceWorkers(mountedAgents);
  const summaryText = coordinator
    ? `${coordinator.name} will coordinate work inside ${workspace.name}.`
    : "Mount a coordinator to enable workspace-level delegation in this workspace.";

  return (
    <div className="grid gap-4">
      <section className="surface-card-faint px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1">
            <span className="section-kicker">Workspace Agents</span>
            <h2 className="m-0 text-[1.15rem] font-semibold leading-[1.2]">
              Configure the delegation surface for {workspace.name}
            </h2>
            <p className="m-0 max-w-[52rem] text-[0.84rem] leading-[1.6] text-[var(--muted)]">
              Mount account-level agents into this workspace, decide who coordinates, and tune how
              successful subtasks flow through review.
            </p>
          </div>
          <div className="rounded-full border border-border bg-[var(--panel)] px-3 py-1.5 text-[0.76rem] text-[var(--muted)]">
            {summaryText}
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <MetricCard
            icon={Bot}
            label="Mounted"
            value={formatCount(mountedAgents.length, "agent")}
            hint={
              mountedAgents.length > 0
                ? `${formatCount(mountedAgents.length, "role assignment")} active in this workspace.`
                : "No account agents are mounted yet."
            }
          />
          <MetricCard
            icon={Crown}
            label="Coordinator"
            value={coordinator?.name ?? "Not assigned"}
            hint={
              coordinator
                ? describeRunnerConfig(coordinator.runnerConfig).detail
                : "Pick one mounted agent to own delegation and planning."
            }
            accent={Boolean(coordinator)}
          />
          <MetricCard
            icon={Users}
            label="Workers"
            value={String(mountedWorkerCount)}
            hint={
              mountedWorkerCount > 0
                ? `${formatCount(mountedWorkerCount, "worker")} available for delegated subtasks.`
                : "No workers mounted yet."
            }
          />
        </div>

      </section>

      <section className="surface-card px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1">
            <span className="section-kicker">Mounted Agents</span>
            <h3 className="m-0 text-[1.02rem] font-semibold">Live delegation lineup</h3>
            <p className="m-0 max-w-[46rem] text-[0.82rem] leading-[1.6] text-[var(--muted)]">
              Mounted agents inherit their runner profile from the shared account-level definition,
              while the role here determines whether they coordinate or execute delegated work.
            </p>
          </div>
          <div className="rounded-full border border-border bg-[var(--surface-soft)] px-3 py-1.5 text-[0.76rem] text-[var(--muted)]">
            {coordinator ? `${coordinator.name} is the active coordinator` : "No coordinator selected"}
          </div>
        </div>

        {mountedAgentsLoadError ? (
          <div className="mt-4 rounded-[var(--radius)] border border-[rgba(181,74,74,0.28)] bg-[rgba(181,74,74,0.08)] px-4 py-3 text-[0.8rem] text-[var(--danger)]">
            {mountedAgentsLoadError}
          </div>
        ) : workspaceAgentsQuery.isLoading ? (
          <p className="mt-4 m-0 text-[0.82rem] text-[var(--muted)]">Loading mounted agents…</p>
        ) : mountedAgents.length === 0 ? (
          <div className="mt-4 grid place-items-center rounded-[var(--radius-lg)] border border-dashed border-border bg-[var(--surface-faint)] px-5 py-10 text-center">
            <div className="grid max-w-[28rem] gap-3">
              <div className="mx-auto grid size-12 place-items-center rounded-full border border-border bg-[var(--panel)] text-[var(--muted)]">
                <Bot className="size-5" />
              </div>
              <div className="grid gap-1">
                <p className="m-0 text-[0.95rem] font-semibold">No mounted agents yet</p>
                <p className="m-0 text-[0.82rem] leading-[1.6] text-[var(--muted)]">
                  Start by mounting a coordinator or worker from the account-level agent pool
                  below.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--panel)]">
            <div className="hidden xl:grid xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_180px_auto] xl:items-center xl:gap-4 xl:border-b xl:border-border xl:bg-[var(--surface-faint)] xl:px-5 xl:py-3">
              <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                Agent
              </span>
              <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                Runner
              </span>
              <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                Role
              </span>
              <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                Actions
              </span>
            </div>

            <ul className="grid">
              {mountedAgents.map((agent, index) => {
                const coordinatorTaken = coordinator && coordinator.id !== agent.id;
                const runner = describeRunnerConfig(agent.runnerConfig);

                return (
                  <li
                    key={agent.id}
                    className={cn(
                      "grid gap-4 px-4 py-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_180px_auto] xl:items-start xl:gap-4 xl:px-5",
                      index > 0 && "border-t border-border",
                      agent.role === "coordinator" && "bg-[rgba(113,112,255,0.06)]"
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <RoleBadge role={agent.role} />
                        <span className="inline-flex min-h-7 items-center rounded-full border border-border px-2.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                          {titleCase(agent.runnerConfig.type)}
                        </span>
                      </div>
                      <h4 className="m-0 mt-3 text-[1rem] font-semibold leading-[1.3]">
                        {agent.name}
                      </h4>
                      <p className="m-0 mt-1 text-[0.74rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                        Account capability
                      </p>
                      <p className="m-0 mt-1 text-[0.82rem] leading-[1.6] text-[var(--muted)]">
                        {agent.description?.trim() || "No account description yet."}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <span className="xl:hidden text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                        Runner
                      </span>
                      <p className="m-0 mt-2 text-[0.9rem] font-semibold leading-[1.4] xl:mt-0">
                        {runner.label}
                      </p>
                      <p className="m-0 mt-1 text-[0.8rem] leading-[1.6] text-[var(--muted)]">
                        {runner.detail}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <label className="grid gap-2">
                        <NativeSelect
                          aria-label={`Workspace role for ${agent.name}`}
                          disabled={mutations.isPending}
                          value={agent.role}
                          onChange={(event) => {
                            const role = event.target.value as WorkspaceAgent["role"];
                            void mutations
                              .updateRole({ agentId: agent.id, role })
                              .then(() => {
                                toast({
                                  title: "Role updated",
                                  description: `${agent.name} is now assigned as ${role}.`
                                });
                              })
                              .catch((nextError) => {
                                toast({
                                  variant: "destructive",
                                  title: "Couldn't update role",
                                  description: readErrorMessage(
                                    nextError,
                                    "Failed to update workspace role."
                                  )
                                });
                              });
                          }}
                        >
                          <option value="worker">worker</option>
                          <option value="coordinator" disabled={Boolean(coordinatorTaken)}>
                            coordinator
                          </option>
                        </NativeSelect>
                      </label>
                    </div>

                    <div className="flex items-start xl:justify-end">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={mutations.isPending}
                        onClick={() => {
                          void mutations.unmount(agent.id)
                            .then(() => {
                              toast({
                                title: "Agent removed",
                                description: `${agent.name} is no longer mounted in ${workspace.name}.`
                              });
                            })
                            .catch((nextError) => {
                              toast({
                                variant: "destructive",
                                title: "Couldn't remove agent",
                                description: readErrorMessage(
                                  nextError,
                                  "Failed to remove mounted agent."
                                )
                              });
                            });
                        }}
                      >
                        Remove
                      </Button>
                    </div>

                    <div className="min-w-0 xl:col-span-full xl:border-t xl:border-border xl:pt-4">
                      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
                        <div className="grid gap-1">
                          <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                            Workspace instructions
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={
                            mutations.isPending ||
                            (workspaceDescriptionDrafts[agent.id] ?? "").trim() ===
                              (agent.workspaceDescription ?? "").trim()
                          }
                          onClick={() => {
                            const workspaceDescription =
                              workspaceDescriptionDrafts[agent.id] ?? "";
                            void mutations
                              .update({
                                agentId: agent.id,
                                body: { workspaceDescription }
                              })
                              .then(() => {
                                toast({
                                  title: "Instructions saved",
                                  description: `${agent.name} has workspace-specific instructions for ${workspace.name}.`
                                });
                              })
                              .catch((nextError) => {
                                toast({
                                  variant: "destructive",
                                  title: "Couldn't save instructions",
                                  description: readErrorMessage(
                                    nextError,
                                    "Failed to update workspace instructions."
                                  )
                                });
                              });
                          }}
                        >
                          Save
                        </Button>
                      </div>
                      <Textarea
                        aria-label={`Workspace instructions for ${agent.name}`}
                        className="min-h-[14rem] resize-y text-[0.86rem] leading-[1.55]"
                        disabled={mutations.isPending}
                        placeholder="How should this agent behave in this workspace?"
                        value={workspaceDescriptionDrafts[agent.id] ?? ""}
                        onChange={(event) =>
                          setWorkspaceDescriptionDrafts((current) => ({
                            ...current,
                            [agent.id]: event.target.value
                          }))
                        }
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section className="surface-card px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1">
            <span className="section-kicker">Agent Library</span>
            <h3 className="m-0 text-[1.02rem] font-semibold">Mount another agent</h3>
            <p className="m-0 max-w-[46rem] text-[0.82rem] leading-[1.6] text-[var(--muted)]">
              Pick from the account-level pool, decide its role in this workspace, then mount it
              without recreating the underlying agent profile.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => navigate("/agents")}>
              Browse agents
            </Button>
            <Button type="button" size="sm" onClick={() => navigate("/agents/new")}>
              <Plus className="size-4" />
              New Agent
            </Button>
          </div>
        </div>

        {agentsLoadError ? (
          <div className="mt-4 rounded-[var(--radius)] border border-[rgba(181,74,74,0.28)] bg-[rgba(181,74,74,0.08)] px-4 py-3 text-[0.8rem] text-[var(--danger)]">
            {agentsLoadError}
          </div>
        ) : agentsQuery.isLoading ? (
          <p className="mt-4 m-0 text-[0.82rem] text-[var(--muted)]">Loading account agents…</p>
        ) : availableAgents.length === 0 ? (
          <div className="mt-4 grid gap-4 rounded-[var(--radius-lg)] border border-dashed border-border bg-[var(--surface-faint)] px-5 py-8 text-center">
            <div className="mx-auto grid size-12 place-items-center rounded-full border border-border bg-[var(--panel)] text-[var(--muted)]">
              <Users className="size-5" />
            </div>
            <div className="grid gap-1">
              <p className="m-0 text-[0.95rem] font-semibold">No more agents to mount</p>
              <p className="m-0 text-[0.82rem] leading-[1.6] text-[var(--muted)]">
                Every account-level agent is already mounted here, or you have not created any
                reusable agents yet.
              </p>
            </div>
            <div className="flex justify-center">
              <Button type="button" size="sm" onClick={() => navigate("/agents/new")}>
                <Plus className="size-4" />
                Create Agent
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--panel)]">
            {availableAgents.map((agent, index) => {
              const runner = describeRunnerConfig(agent.runnerConfig);

              return (
                <div
                  key={agent.id}
                  className={cn(
                    "flex flex-wrap items-center gap-4 px-4 py-3",
                    index > 0 && "border-t border-border"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[0.9rem] font-semibold leading-[1.3]">
                        {agent.name}
                      </span>
                      <span className="inline-flex min-h-6 items-center rounded-full border border-border px-2 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                        {titleCase(agent.runnerConfig.type)}
                      </span>
                    </div>
                    <p className="m-0 mt-0.5 truncate text-[0.78rem] leading-[1.5] text-[var(--muted)]">
                      {agent.description?.trim() || "No description yet."}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-[0.74rem] leading-[1.4] text-[var(--muted)]">
                    <div>{runner.label}</div>
                    <div className="truncate max-w-[14rem]">{runner.detail}</div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={mutations.isPending}
                      onClick={() => mountAgent(agent.id, "worker", agent.name)}
                    >
                      Mount as worker
                    </Button>
                    {!coordinator ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={mutations.isPending}
                        onClick={() => mountAgent(agent.id, "coordinator", agent.name)}
                      >
                        Mount as coordinator
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

    </div>
  );
}
