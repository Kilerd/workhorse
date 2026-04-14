import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  Workspace,
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
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

// ---------------------------------------------------------------------------
// Tab definition
// ---------------------------------------------------------------------------

type TabId = "general" | WorkspacePromptTemplateId;

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "general", label: "General" },
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
    activeTab === "general" ? WORKSPACE_PROMPT_TEMPLATE_IDS[0] : activeTab;

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
        <div className="px-4 py-4">
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
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(() => {
    navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [token]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="shrink-0 cursor-pointer rounded bg-transparent font-mono text-[0.68rem] text-[var(--accent-strong)] transition-colors hover:text-foreground"
      title="Click to copy"
    >
      {copied ? "Copied!" : token}
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
    <div className="grid gap-5">
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
