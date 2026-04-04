import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ClaudePermissionMode,
  GlobalSettings,
  Workspace,
  WorkspaceCodexSettings
} from "@workhorse/contracts";
import {
  DEFAULT_GLOBAL_LANGUAGE,
  DEFAULT_OPENROUTER_BASE_URL
} from "@workhorse/contracts";

import { api } from "@/lib/api";
import { formatTaskBranchPreview } from "@/lib/format";
import { BOARD_COLUMNS, type TaskFormValues } from "@/lib/task-view";
import { resolveTaskWorkspaceId } from "@/lib/workspace-selection";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

const DEFAULT_CODEX_PROMPT = "请完成用户请求的任务。";
const DEFAULT_CLAUDE_PROMPT =
  "Review the current task carefully and summarize concrete risks, regressions, and missing tests.";
const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  language: DEFAULT_GLOBAL_LANGUAGE,
  openRouter: {
    baseUrl: DEFAULT_OPENROUTER_BASE_URL,
    token: "",
    model: ""
  }
};

const modalBackdropClass =
  "fixed inset-0 z-20 grid place-items-center bg-[var(--backdrop)] p-4";
const modalCardClass =
  "grid w-[min(92vw,640px)] gap-4 rounded-none border border-border bg-[var(--panel)] p-4 shadow-[var(--shadow)]";
const modalWideClass = "w-[min(92vw,820px)]";
const modalTitleClass = "text-base font-semibold";
const modalGridClass = "grid grid-cols-2 gap-4 max-[1040px]:grid-cols-1";
const modalLabelClass = "grid gap-2";
const modalLabelTextClass =
  "m-0 font-mono text-[0.64rem] uppercase tracking-[0.14em] text-[var(--accent)]";
const modalNoteClass =
  "grid gap-2 rounded-none border border-border bg-[var(--panel)] p-3 [&_p]:m-0 [&_p]:text-[var(--muted)] [&_code]:break-words";
const modalActionsClass = "flex flex-wrap justify-end gap-2";
const span2Class = "col-span-2 max-[1040px]:col-span-1";
const fieldHintClass = "m-0 text-[0.75rem] text-[var(--muted)]";
const fieldErrorClass = "m-0 text-[0.75rem] text-[var(--danger)]";
const mutedTextClass = "text-[var(--muted)]";

const APPROVAL_POLICY_OPTIONS: Array<{
  value: WorkspaceCodexSettings["approvalPolicy"];
  label: string;
  description: string;
}> = [
  {
    value: "untrusted",
    label: "untrusted",
    description: "Ask before running commands outside the trusted set."
  },
  {
    value: "on-request",
    label: "on-request",
    description: "Let Codex decide when to ask for approval."
  },
  {
    value: "on-failure",
    label: "on-failure",
    description: "Run first, and only escalate after a sandbox failure."
  },
  {
    value: "never",
    label: "never",
    description: "Never ask for approval."
  }
];

const SANDBOX_MODE_OPTIONS: Array<{
  value: WorkspaceCodexSettings["sandboxMode"];
  label: string;
  description: string;
}> = [
  {
    value: "read-only",
    label: "read-only",
    description: "Inspect files without modifying the workspace."
  },
  {
    value: "workspace-write",
    label: "workspace-write",
    description: "Allow edits inside the workspace while keeping stronger limits elsewhere."
  },
  {
    value: "danger-full-access",
    label: "danger-full-access",
    description: "Bypass sandbox protections completely."
  }
];

const CLAUDE_PERMISSION_MODE_OPTIONS: Array<{
  value: ClaudePermissionMode;
  label: string;
  description: string;
}> = [
  {
    value: "default",
    label: "default",
    description: "Use Claude Code's standard permission flow."
  },
  {
    value: "acceptEdits",
    label: "acceptEdits",
    description: "Auto-accept edit requests while keeping other checks in place."
  },
  {
    value: "dontAsk",
    label: "dontAsk",
    description: "Run without permission prompts when Claude Code supports it."
  },
  {
    value: "plan",
    label: "plan",
    description: "Keep Claude in planning mode for review-only workflows."
  },
  {
    value: "bypassPermissions",
    label: "bypassPermissions",
    description: "Bypass permission checks. Only use in trusted environments."
  }
];

interface WorkspaceModalProps {
  open: boolean;
  onClose(): void;
  onSubmit(values: { name: string; rootPath: string }): void;
}

interface WorkspaceSettingsModalProps {
  open: boolean;
  workspace: Workspace | null;
  taskCount: number;
  onClose(): void;
  onSubmit(values: { name: string; codexSettings: WorkspaceCodexSettings }): void;
}

interface GlobalSettingsModalProps {
  open: boolean;
  settings: GlobalSettings | null;
  onClose(): void;
  onSubmit(values: GlobalSettings): void;
}

interface TaskModalProps {
  open: boolean;
  workspaces: Workspace[];
  selectedWorkspaceId: string | "all";
  settings: GlobalSettings | null;
  submitting: boolean;
  onClose(): void;
  onSubmit(values: TaskFormValues): Promise<void> | void;
}

function useCloseOnEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);
}


function describeApprovalPolicy(
  value: WorkspaceCodexSettings["approvalPolicy"]
): string {
  return (
    APPROVAL_POLICY_OPTIONS.find((option) => option.value === value)?.description ??
    value
  );
}

function describeSandboxMode(value: WorkspaceCodexSettings["sandboxMode"]): string {
  return (
    SANDBOX_MODE_OPTIONS.find((option) => option.value === value)?.description ??
    value
  );
}

function hasCompleteOpenRouterConfig(settings: GlobalSettings): boolean {
  return Boolean(
    settings.openRouter.baseUrl.trim() &&
      settings.openRouter.token.trim() &&
      settings.openRouter.model.trim()
  );
}

function deriveWorkspaceNameFromPath(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return "";
  }

  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] ?? "";
}

function readApiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data?: { error?: { message?: string } } }).data;
    if (data?.error?.message) {
      return data.error.message;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

export function WorkspaceModal({ open, onClose, onSubmit }: WorkspaceModalProps) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [isPickingRoot, setIsPickingRoot] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  useCloseOnEscape(open, onClose);

  useEffect(() => {
    if (!open) {
      setName("");
      setRootPath("");
      setIsPickingRoot(false);
      setPickerError(null);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const trimmedName = name.trim();
  const trimmedRootPath = rootPath.trim();
  const canSubmit = Boolean(trimmedName && trimmedRootPath) && !isPickingRoot;

  return (
    <div className={modalBackdropClass} role="presentation" onClick={onClose}>
      <form
        className={modalCardClass}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) {
            return;
          }

          onSubmit({ name: trimmedName, rootPath: trimmedRootPath });
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className={modalTitleClass}>Add workspace</h2>
        <label className={modalLabelClass}>
          <span className={modalLabelTextClass}>Name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Frontend"
          />
        </label>
        <label className={modalLabelClass}>
          <span className={modalLabelTextClass}>Root path</span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-stretch gap-2 max-[640px]:grid-cols-1">
            <Input
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder="/Users/you/projects/app"
            />
            <Button
              type="button"
              variant="secondary"
              disabled={isPickingRoot}
              onClick={() => {
                setPickerError(null);
                setIsPickingRoot(true);

                void api
                  .pickWorkspaceRoot()
                  .then((response) => {
                    const selectedRootPath = response.rootPath;
                    if (!selectedRootPath) {
                      return;
                    }

                    setRootPath(selectedRootPath);
                    setName((current) =>
                      current.trim() ? current : deriveWorkspaceNameFromPath(selectedRootPath)
                    );
                  })
                  .catch((error: unknown) => {
                    setPickerError(
                      readApiErrorMessage(
                        error,
                        "Unable to open the folder picker. Enter the path manually."
                      )
                    );
                  })
                  .finally(() => {
                    setIsPickingRoot(false);
                  });
              }}
            >
              {isPickingRoot ? "Choosing..." : "Choose folder"}
            </Button>
          </div>
          <p className={fieldHintClass}>Pick a local folder or paste an absolute path.</p>
          {pickerError ? <p className={fieldErrorClass}>{pickerError}</p> : null}
        </label>
        <div className={modalActionsClass}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            Create
          </Button>
        </div>
      </form>
    </div>
  );
}

export function WorkspaceSettingsModal({
  open,
  workspace,
  taskCount,
  onClose,
  onSubmit
}: WorkspaceSettingsModalProps) {
  const [name, setName] = useState("");
  const [approvalPolicy, setApprovalPolicy] =
    useState<WorkspaceCodexSettings["approvalPolicy"]>("on-request");
  const [sandboxMode, setSandboxMode] =
    useState<WorkspaceCodexSettings["sandboxMode"]>("workspace-write");

  useCloseOnEscape(open, onClose);

  useEffect(() => {
    if (!open || !workspace) {
      setName("");
      setApprovalPolicy("on-request");
      setSandboxMode("workspace-write");
      return;
    }

    setName(workspace.name);
    setApprovalPolicy(workspace.codexSettings.approvalPolicy);
    setSandboxMode(workspace.codexSettings.sandboxMode);
  }, [open, workspace]);

  if (!open || !workspace) {
    return null;
  }

  const canSubmit = Boolean(name.trim());

  return (
    <div className={modalBackdropClass} role="presentation" onClick={onClose}>
      <form
        className={cn(modalCardClass, modalWideClass)}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            name,
            codexSettings: {
              approvalPolicy,
              sandboxMode
            }
          });
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className={modalTitleClass}>Workspace settings</h2>
        <div className={modalGridClass}>
          <label className={modalLabelClass}>
            <span className={modalLabelTextClass}>Name</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className={modalNoteClass}>
            <span className={modalLabelTextClass}>Root path</span>
            <p>
              <code>{workspace.rootPath}</code>
            </p>
          </div>
          <label className={modalLabelClass}>
            <span className={modalLabelTextClass}>Approval policy</span>
            <NativeSelect
              value={approvalPolicy}
              onChange={(event) =>
                setApprovalPolicy(
                  event.target.value as WorkspaceCodexSettings["approvalPolicy"]
                )
              }
            >
              {APPROVAL_POLICY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </label>
          <div className={modalNoteClass}>
            <span className={modalLabelTextClass}>Approval behavior</span>
            <p>{describeApprovalPolicy(approvalPolicy)}</p>
          </div>
          <label className={modalLabelClass}>
            <span className={modalLabelTextClass}>Sandbox</span>
            <NativeSelect
              value={sandboxMode}
              onChange={(event) =>
                setSandboxMode(event.target.value as WorkspaceCodexSettings["sandboxMode"])
              }
            >
              {SANDBOX_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </label>
          <div className={modalNoteClass}>
            <span className={modalLabelTextClass}>Sandbox access</span>
            <p>{describeSandboxMode(sandboxMode)}</p>
          </div>
          <div className={cn(modalNoteClass, span2Class)}>
            <span className={modalLabelTextClass}>Applies to future Codex runs</span>
            <p>
              Codex tasks in this workspace will use <code>{approvalPolicy}</code> and{" "}
              <code>{sandboxMode}</code>. Shell tasks are unchanged.
            </p>
          </div>
          <div className={cn(modalNoteClass, span2Class)}>
            <span className={modalLabelTextClass}>Workspace context</span>
            <p>
              {workspace.isGitRepo ? "Git repository" : "Non-Git directory"} with {taskCount}{" "}
              {taskCount === 1 ? "task" : "tasks"}.
            </p>
          </div>
        </div>
        <div className={modalActionsClass}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            Save settings
          </Button>
        </div>
      </form>
    </div>
  );
}

export function GlobalSettingsModal({
  open,
  settings,
  onClose,
  onSubmit
}: GlobalSettingsModalProps) {
  const resolvedSettings = settings ?? DEFAULT_GLOBAL_SETTINGS;
  const [language, setLanguage] = useState(DEFAULT_GLOBAL_SETTINGS.language);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_GLOBAL_SETTINGS.openRouter.baseUrl);
  const [token, setToken] = useState("");
  const [model, setModel] = useState("");

  useCloseOnEscape(open, onClose);

  useEffect(() => {
    if (!open) {
      setLanguage(DEFAULT_GLOBAL_SETTINGS.language);
      setBaseUrl(DEFAULT_GLOBAL_SETTINGS.openRouter.baseUrl);
      setToken("");
      setModel("");
      return;
    }

    setLanguage(resolvedSettings.language);
    setBaseUrl(resolvedSettings.openRouter.baseUrl);
    setToken(resolvedSettings.openRouter.token);
    setModel(resolvedSettings.openRouter.model);
  }, [open, resolvedSettings]);

  if (!open) {
    return null;
  }

  return (
    <div className={modalBackdropClass} role="presentation" onClick={onClose}>
      <form
        className={cn(modalCardClass, modalWideClass)}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            language,
            openRouter: {
              baseUrl,
              token,
              model
            }
          });
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className={modalTitleClass}>Global settings</h2>
        <div className={modalGridClass}>
          <label className={modalLabelClass}>
            <span className={modalLabelTextClass}>Language</span>
            <Input
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              placeholder={DEFAULT_GLOBAL_SETTINGS.language}
            />
          </label>
          <div className={modalNoteClass}>
            <span className={modalLabelTextClass}>Default behavior</span>
            <p>
              When a task is created from description only, AI will generate the title
              in <code>{language.trim() || DEFAULT_GLOBAL_SETTINGS.language}</code>.
            </p>
          </div>
          <label className={cn(modalLabelClass, span2Class)}>
            <span className={modalLabelTextClass}>OpenRouter base URL</span>
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={DEFAULT_GLOBAL_SETTINGS.openRouter.baseUrl}
            />
          </label>
          <label className={modalLabelClass}>
            <span className={modalLabelTextClass}>OpenRouter token</span>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="sk-or-v1-..."
            />
          </label>
          <label className={modalLabelClass}>
            <span className={modalLabelTextClass}>OpenRouter model</span>
            <Input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="openai/gpt-4o-mini"
            />
          </label>
          <div className={cn(modalNoteClass, span2Class)}>
            <span className={modalLabelTextClass}>AI task naming</span>
            <p>
              Workhorse uses this OpenRouter config to generate a simple task title and
              worktree name when the title is left empty.
            </p>
          </div>
        </div>
        <div className={modalActionsClass}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">
            Save settings
          </Button>
        </div>
      </form>
    </div>
  );
}

export function TaskModal({
  open,
  workspaces,
  selectedWorkspaceId,
  settings,
  submitting,
  onClose,
  onSubmit
}: TaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workspaceId, setWorkspaceId] = useState(() =>
    resolveTaskWorkspaceId(workspaces, selectedWorkspaceId)
  );
  const [runnerType, setRunnerType] = useState<"claude" | "shell" | "codex">("codex");
  const [shellCommand, setShellCommand] = useState("npm test");
  const [prompt, setPrompt] = useState(DEFAULT_CODEX_PROMPT);
  const [claudeAgent, setClaudeAgent] = useState("code-reviewer");
  const [claudeModel, setClaudeModel] = useState("");
  const [claudePermissionMode, setClaudePermissionMode] =
    useState<ClaudePermissionMode>("default");
  const [column, setColumn] = useState<TaskFormValues["column"]>("backlog");
  const [worktreeBaseRef, setWorktreeBaseRef] = useState("");
  const [submitLocked, setSubmitLocked] = useState(false);
  const defaultWorkspaceId = resolveTaskWorkspaceId(workspaces, selectedWorkspaceId);
  const resolvedSettings = settings ?? DEFAULT_GLOBAL_SETTINGS;
  const canGenerateTitle = hasCompleteOpenRouterConfig(resolvedSettings);

  useCloseOnEscape(open, onClose);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId),
    [workspaceId, workspaces]
  );
  const gitRefsQuery = useQuery({
    queryKey: ["workspace-git-refs", selectedWorkspace?.id ?? ""],
    queryFn: async () => {
      if (!selectedWorkspace?.id) {
        return [];
      }
      const response = await api.listWorkspaceGitRefs(selectedWorkspace.id);
      return response.items;
    },
    enabled: open && Boolean(selectedWorkspace?.isGitRepo && selectedWorkspace.id)
  });

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setWorkspaceId(defaultWorkspaceId);
      setRunnerType("codex");
      setShellCommand("npm test");
      setPrompt(DEFAULT_CODEX_PROMPT);
      setClaudeAgent("code-reviewer");
      setClaudeModel("");
      setClaudePermissionMode("default");
      setColumn("backlog");
      setWorktreeBaseRef("");
      setSubmitLocked(false);
    }
  }, [defaultWorkspaceId, open]);

  useEffect(() => {
    if (!submitting) {
      setSubmitLocked(false);
    }
  }, [submitting]);

  useEffect(() => {
    if (!workspaceId && defaultWorkspaceId) {
      setWorkspaceId(defaultWorkspaceId);
      return;
    }

    if (workspaceId && !workspaces.some((workspace) => workspace.id === workspaceId)) {
      setWorkspaceId(defaultWorkspaceId);
    }
  }, [defaultWorkspaceId, workspaceId, workspaces]);

  useEffect(() => {
    if (!selectedWorkspace?.isGitRepo) {
      setWorktreeBaseRef("");
      return;
    }

    const refs = gitRefsQuery.data ?? [];
    if (refs.length === 0) {
      return;
    }

    if (refs.some((ref) => ref.name === worktreeBaseRef)) {
      return;
    }

    const defaultRef = refs.find((ref) => ref.isDefault)?.name ?? refs[0]?.name ?? "";
    if (defaultRef) {
      setWorktreeBaseRef(defaultRef);
    }
  }, [gitRefsQuery.data, selectedWorkspace?.isGitRepo, worktreeBaseRef]);

  if (!open) {
    return null;
  }

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const isSubmitting = submitting || submitLocked;
  const submitStatusLabel =
    !trimmedTitle && Boolean(trimmedDescription) && canGenerateTitle
      ? "Generating AI title and creating task..."
      : "Creating task...";
  const usesAiBranchPreview =
    !trimmedTitle && Boolean(trimmedDescription) && canGenerateTitle;
  const canSubmit =
    workspaces.length > 0 &&
    Boolean(workspaceId) &&
    (Boolean(trimmedTitle) || (Boolean(trimmedDescription) && canGenerateTitle)) &&
    (!selectedWorkspace?.isGitRepo || Boolean(worktreeBaseRef)) &&
    !isSubmitting;
  const branchPreview = formatTaskBranchPreview(
    usesAiBranchPreview ? "ai-generated-name" : trimmedTitle || "task",
    {
      omitGeneratedId: usesAiBranchPreview
    }
  );

  return (
    <div className={modalBackdropClass} role="presentation" onClick={onClose}>
      <form
        className={cn(modalCardClass, modalWideClass)}
        onSubmit={(event) => {
          event.preventDefault();
          if (isSubmitting) {
            return;
          }

          setSubmitLocked(true);
          void Promise.resolve(
            onSubmit({
              title,
              description,
              workspaceId,
              runnerType,
              runnerConfig:
                runnerType === "shell"
                  ? { type: "shell", command: shellCommand }
                  : runnerType === "claude"
                    ? {
                        type: "claude",
                        prompt,
                        agent: claudeAgent.trim() || undefined,
                        model: claudeModel.trim() || undefined,
                        permissionMode: claudePermissionMode
                      }
                    : { type: "codex", prompt },
              column,
              worktreeBaseRef:
                selectedWorkspace?.isGitRepo && worktreeBaseRef
                  ? worktreeBaseRef
                  : undefined
            })
          ).catch(() => {
            setSubmitLocked(false);
          });
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className={modalTitleClass}>Create task</h2>
        {workspaces.length === 0 ? (
          <p className={cn("m-0", mutedTextClass)}>Add a workspace before creating tasks.</p>
        ) : null}
        <div className={modalGridClass}>
          <label className={modalLabelClass}>
            <span className={modalLabelTextClass}>Title</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Fix onboarding flow"
            />
          </label>
          <label className={modalLabelClass}>
            <span className={modalLabelTextClass}>Workspace</span>
            <NativeSelect
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className={cn(modalLabelClass, span2Class)}>
            <span className={modalLabelTextClass}>Description</span>
            <Textarea
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe what needs to happen."
            />
          </label>
          <div className={cn(modalNoteClass, span2Class)}>
            <span className={modalLabelTextClass}>Title generation</span>
            <p>
              {canGenerateTitle
                ? `If title is empty, Workhorse will use AI to generate a simple ${resolvedSettings.language} title and worktree name from the description.`
                : "To create a task from description only, first fill in OpenRouter base URL, token, and model in global settings."}
            </p>
          </div>
          <label className={modalLabelClass}>
            <span className={modalLabelTextClass}>Runner</span>
            <NativeSelect
              value={runnerType}
              onChange={(event) => {
                const nextRunnerType = event.target.value as "claude" | "shell" | "codex";
                setRunnerType(nextRunnerType);
                setPrompt((current) => {
                  if (nextRunnerType === "claude" && current === DEFAULT_CODEX_PROMPT) {
                    return DEFAULT_CLAUDE_PROMPT;
                  }
                  if (nextRunnerType === "codex" && current === DEFAULT_CLAUDE_PROMPT) {
                    return DEFAULT_CODEX_PROMPT;
                  }
                  return current;
                });
              }}
            >
              <option value="codex">codex</option>
              <option value="claude">claude</option>
              <option value="shell">shell</option>
            </NativeSelect>
          </label>
          <label className={modalLabelClass}>
            <span className={modalLabelTextClass}>Column</span>
            <NativeSelect
              value={column}
              onChange={(event) => setColumn(event.target.value as TaskFormValues["column"])}
            >
              {BOARD_COLUMNS.map((boardColumn) => (
                <option key={boardColumn.id} value={boardColumn.id}>
                  {boardColumn.id}
                </option>
              ))}
            </NativeSelect>
          </label>
          {selectedWorkspace?.isGitRepo ? (
            <>
              <label className={modalLabelClass}>
                <span className={modalLabelTextClass}>Base ref</span>
                <NativeSelect
                  value={worktreeBaseRef}
                  onChange={(event) => setWorktreeBaseRef(event.target.value)}
                  disabled={gitRefsQuery.isLoading || (gitRefsQuery.data?.length ?? 0) === 0}
                >
                  {(gitRefsQuery.data ?? []).map((ref) => (
                    <option key={ref.name} value={ref.name}>
                      {ref.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <div className={modalNoteClass}>
                <span className={modalLabelTextClass}>Task branch</span>
                <p>
                  Workhorse will generate a stable branch like <code>{branchPreview}</code>.
                </p>
              </div>
            </>
          ) : null}
          {runnerType === "shell" ? (
            <label className={cn(modalLabelClass, span2Class)}>
              <span className={modalLabelTextClass}>Command</span>
              <Input
                value={shellCommand}
                onChange={(event) => setShellCommand(event.target.value)}
                placeholder="npm test"
              />
            </label>
          ) : (
            <>
              <label className={cn(modalLabelClass, span2Class)}>
                <span className={modalLabelTextClass}>Prompt</span>
                <Textarea
                  rows={5}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={
                    runnerType === "claude" ? DEFAULT_CLAUDE_PROMPT : DEFAULT_CODEX_PROMPT
                  }
                />
              </label>
              {runnerType === "claude" ? (
                <>
                  <label className={modalLabelClass}>
                    <span className={modalLabelTextClass}>Claude agent</span>
                    <Input
                      value={claudeAgent}
                      onChange={(event) => setClaudeAgent(event.target.value)}
                      placeholder="code-reviewer"
                    />
                  </label>
                  <label className={modalLabelClass}>
                    <span className={modalLabelTextClass}>Permission mode</span>
                    <NativeSelect
                      value={claudePermissionMode}
                      onChange={(event) =>
                        setClaudePermissionMode(event.target.value as ClaudePermissionMode)
                      }
                    >
                      {CLAUDE_PERMISSION_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </NativeSelect>
                    <p className={fieldHintClass}>
                      {
                        CLAUDE_PERMISSION_MODE_OPTIONS.find(
                          (option) => option.value === claudePermissionMode
                        )?.description
                      }
                    </p>
                  </label>
                  <label className={cn(modalLabelClass, span2Class)}>
                    <span className={modalLabelTextClass}>Model override</span>
                    <Input
                      value={claudeModel}
                      onChange={(event) => setClaudeModel(event.target.value)}
                      placeholder="claude-sonnet-4-6"
                    />
                    <p className={fieldHintClass}>
                      Leave blank to use the local Claude Code default model.
                    </p>
                  </label>
                  <div className={cn(modalNoteClass, span2Class)}>
                    <span className={modalLabelTextClass}>Claude CLI runtime</span>
                    <p>
                      Workhorse will run <code>claude -p</code> in this workspace and stream
                      structured JSON events into the task log.
                    </p>
                  </div>
                </>
              ) : selectedWorkspace ? (
                <div className={cn(modalNoteClass, span2Class)}>
                  <span className={modalLabelTextClass}>Workspace Codex settings</span>
                  <p>
                    This task will use <code>{selectedWorkspace.codexSettings.approvalPolicy}</code>{" "}
                    approval with <code>{selectedWorkspace.codexSettings.sandboxMode}</code>{" "}
                    sandboxing.
                  </p>
                </div>
              ) : null}
            </>
          )}
          {selectedWorkspace?.isGitRepo && gitRefsQuery.isLoading ? (
            <p className={cn("m-0", mutedTextClass, span2Class)}>Loading Git refs…</p>
          ) : null}
          {selectedWorkspace?.isGitRepo && gitRefsQuery.isError ? (
            <p className={cn("m-0", mutedTextClass, span2Class)}>
              Git refs could not be loaded right now.
            </p>
          ) : null}
        </div>
        <div className={modalActionsClass}>
          {isSubmitting ? (
            <p className="mr-auto text-[0.75rem] leading-7 text-[var(--muted)]">
              {submitStatusLabel}
            </p>
          ) : null}
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {isSubmitting ? "Creating..." : "Create task"}
          </Button>
        </div>
      </form>
    </div>
  );
}
