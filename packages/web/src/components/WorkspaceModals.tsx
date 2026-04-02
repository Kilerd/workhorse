import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  GlobalSettings,
  Workspace,
  WorkspaceCodexSettings
} from "@workhorse/contracts";
import {
  DEFAULT_GLOBAL_LANGUAGE,
  DEFAULT_OPENROUTER_BASE_URL
} from "@workhorse/contracts";

import { api } from "@/lib/api";
import { BOARD_COLUMNS, type TaskFormValues } from "@/lib/task-view";
import { resolveTaskWorkspaceId } from "@/lib/workspace-selection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

const DEFAULT_CODEX_PROMPT = "请完成用户请求的任务。";
const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  language: DEFAULT_GLOBAL_LANGUAGE,
  openRouter: {
    baseUrl: DEFAULT_OPENROUTER_BASE_URL,
    token: "",
    model: ""
  }
};

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

function slugifyBranchPreview(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return slug || "task";
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
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) {
            return;
          }

          onSubmit({ name: trimmedName, rootPath: trimmedRootPath });
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Add workspace</h2>
        <label>
          <span>Name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Frontend"
          />
        </label>
        <label>
          <span>Root path</span>
          <div className="input-with-action">
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
                    const selectedRootPath = response.data.rootPath;
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
          <p className="field-hint">Pick a local folder or paste an absolute path.</p>
          {pickerError ? <p className="field-error">{pickerError}</p> : null}
        </label>
        <div className="modal-actions">
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
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal modal-wide"
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
        <h2>Workspace settings</h2>
        <div className="modal-grid">
          <label>
            <span>Name</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="modal-note">
            <span>Root path</span>
            <p>
              <code>{workspace.rootPath}</code>
            </p>
          </div>
          <label>
            <span>Approval policy</span>
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
          <div className="modal-note">
            <span>Approval behavior</span>
            <p>{describeApprovalPolicy(approvalPolicy)}</p>
          </div>
          <label>
            <span>Sandbox</span>
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
          <div className="modal-note">
            <span>Sandbox access</span>
            <p>{describeSandboxMode(sandboxMode)}</p>
          </div>
          <div className="modal-note span-2">
            <span>Applies to future Codex runs</span>
            <p>
              Codex tasks in this workspace will use <code>{approvalPolicy}</code> and{" "}
              <code>{sandboxMode}</code>. Shell tasks are unchanged.
            </p>
          </div>
          <div className="modal-note span-2">
            <span>Workspace context</span>
            <p>
              {workspace.isGitRepo ? "Git repository" : "Non-Git directory"} with {taskCount}{" "}
              {taskCount === 1 ? "task" : "tasks"}.
            </p>
          </div>
        </div>
        <div className="modal-actions">
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
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal modal-wide"
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
        <h2>Global settings</h2>
        <div className="modal-grid">
          <label>
            <span>Language</span>
            <Input
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              placeholder={DEFAULT_GLOBAL_SETTINGS.language}
            />
          </label>
          <div className="modal-note">
            <span>Default behavior</span>
            <p>
              When a task is created from description only, AI will generate the title
              in <code>{language.trim() || DEFAULT_GLOBAL_SETTINGS.language}</code>.
            </p>
          </div>
          <label className="span-2">
            <span>OpenRouter base URL</span>
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={DEFAULT_GLOBAL_SETTINGS.openRouter.baseUrl}
            />
          </label>
          <label>
            <span>OpenRouter token</span>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="sk-or-v1-..."
            />
          </label>
          <label>
            <span>OpenRouter model</span>
            <Input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="openai/gpt-4o-mini"
            />
          </label>
          <div className="modal-note span-2">
            <span>AI task naming</span>
            <p>
              Workhorse uses this OpenRouter config to generate a simple task title and
              worktree name when the title is left empty.
            </p>
          </div>
        </div>
        <div className="modal-actions">
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
  const [runnerType, setRunnerType] = useState<"shell" | "codex">("codex");
  const [shellCommand, setShellCommand] = useState("npm test");
  const [prompt, setPrompt] = useState(DEFAULT_CODEX_PROMPT);
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
      return response.data.items;
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
  const canSubmit =
    workspaces.length > 0 &&
    Boolean(workspaceId) &&
    (Boolean(trimmedTitle) || (Boolean(trimmedDescription) && canGenerateTitle)) &&
    (!selectedWorkspace?.isGitRepo || Boolean(worktreeBaseRef)) &&
    !isSubmitting;
  const branchPreview = `task/<generated-id>-${slugifyBranchPreview(
    trimmedTitle || (canGenerateTitle ? "ai-generated-name" : "task")
  )}`;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal modal-wide"
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
        <h2>Create task</h2>
        {workspaces.length === 0 ? (
          <p className="muted">Add a workspace before creating tasks.</p>
        ) : null}
        <div className="modal-grid">
          <label>
            <span>Title</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Fix onboarding flow"
            />
          </label>
          <label>
            <span>Workspace</span>
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
          <label className="span-2">
            <span>Description</span>
            <Textarea
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe what needs to happen."
            />
          </label>
          <div className="modal-note span-2">
            <span>Title generation</span>
            <p>
              {canGenerateTitle
                ? `If title is empty, Workhorse will use AI to generate a simple ${resolvedSettings.language} title and worktree name from the description.`
                : "To create a task from description only, first fill in OpenRouter base URL, token, and model in global settings."}
            </p>
          </div>
          <label>
            <span>Runner</span>
            <NativeSelect
              value={runnerType}
              onChange={(event) =>
                setRunnerType(event.target.value as "shell" | "codex")
              }
            >
              <option value="codex">codex</option>
              <option value="shell">shell</option>
            </NativeSelect>
          </label>
          <label>
            <span>Column</span>
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
              <label>
                <span>Base ref</span>
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
              <div className="modal-note">
                <span>Task branch</span>
                <p>
                  Workhorse will generate a stable branch like <code>{branchPreview}</code>.
                </p>
              </div>
            </>
          ) : null}
          {runnerType === "shell" ? (
            <label className="span-2">
              <span>Command</span>
              <Input
                value={shellCommand}
                onChange={(event) => setShellCommand(event.target.value)}
                placeholder="npm test"
              />
            </label>
          ) : (
            <>
              <label className="span-2">
                <span>Prompt</span>
                <Textarea
                  rows={5}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={DEFAULT_CODEX_PROMPT}
                />
              </label>
              {selectedWorkspace ? (
                <div className="modal-note span-2">
                  <span>Workspace Codex settings</span>
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
            <p className="muted span-2">Loading Git refs…</p>
          ) : null}
          {selectedWorkspace?.isGitRepo && gitRefsQuery.isError ? (
            <p className="muted span-2">Git refs could not be loaded right now.</p>
          ) : null}
        </div>
        <div className="modal-actions">
          {isSubmitting ? <p className="modal-actions-status">{submitStatusLabel}</p> : null}
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
