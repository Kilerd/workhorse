import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Workspace } from "@workhorse/contracts";

import { api } from "@/lib/api";
import type { DisplayTaskColumn, TaskFormValues } from "@/lib/task-view";

const DEFAULT_CODEX_PROMPT = "请完成用户请求的任务。";

interface WorkspaceModalProps {
  open: boolean;
  onClose(): void;
  onSubmit(values: { name: string; rootPath: string }): void;
}

interface TaskModalProps {
  open: boolean;
  workspaces: Workspace[];
  onClose(): void;
  onSubmit(values: TaskFormValues): void;
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

export function WorkspaceModal({ open, onClose, onSubmit }: WorkspaceModalProps) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");

  useCloseOnEscape(open, onClose);

  useEffect(() => {
    if (!open) {
      setName("");
      setRootPath("");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name, rootPath });
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Add workspace</h2>
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Frontend" />
        </label>
        <label>
          <span>Root path</span>
          <input
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="/Users/you/projects/app"
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button">
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

export function TaskModal({ open, workspaces, onClose, onSubmit }: TaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [runnerType, setRunnerType] = useState<"shell" | "codex">("codex");
  const [shellCommand, setShellCommand] = useState("npm test");
  const [prompt, setPrompt] = useState(DEFAULT_CODEX_PROMPT);
  const [column, setColumn] = useState<TaskFormValues["column"]>("backlog");
  const [worktreeBaseRef, setWorktreeBaseRef] = useState("");

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
      setWorkspaceId(workspaces[0]?.id ?? "");
      setRunnerType("codex");
      setShellCommand("npm test");
      setPrompt(DEFAULT_CODEX_PROMPT);
      setColumn("backlog");
      setWorktreeBaseRef("");
    }
  }, [open, workspaces]);

  useEffect(() => {
    if (!workspaceId && workspaces[0]) {
      setWorkspaceId(workspaces[0].id);
    }
  }, [workspaceId, workspaces]);

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

  const canSubmit =
    workspaces.length > 0 &&
    Boolean(title.trim()) &&
    Boolean(workspaceId) &&
    (!selectedWorkspace?.isGitRepo || Boolean(worktreeBaseRef));
  const branchPreview = `task/<generated-id>-${slugifyBranchPreview(title)}`;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal modal-wide"
        onSubmit={(event) => {
          event.preventDefault();
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
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Fix onboarding flow" />
          </label>
          <label>
            <span>Workspace</span>
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
          <label className="span-2">
            <span>Description</span>
            <textarea
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe what needs to happen."
            />
          </label>
          <label>
            <span>Runner</span>
            <select value={runnerType} onChange={(event) => setRunnerType(event.target.value as "shell" | "codex")}>
              <option value="codex">codex</option>
              <option value="shell">shell</option>
            </select>
          </label>
          <label>
            <span>Column</span>
            <select
              value={column}
              onChange={(event) => setColumn(event.target.value as DisplayTaskColumn)}
            >
              <option value="backlog">backlog</option>
              <option value="todo">todo</option>
              <option value="running">running</option>
              <option value="review">review</option>
              <option value="done">done</option>
              <option value="archived">archived</option>
            </select>
          </label>
          {selectedWorkspace?.isGitRepo ? (
            <>
              <label>
                <span>Base ref</span>
                <select
                  value={worktreeBaseRef}
                  onChange={(event) => setWorktreeBaseRef(event.target.value)}
                  disabled={gitRefsQuery.isLoading || (gitRefsQuery.data?.length ?? 0) === 0}
                >
                  {(gitRefsQuery.data ?? []).map((ref) => (
                    <option key={ref.name} value={ref.name}>
                      {ref.name}
                    </option>
                  ))}
                </select>
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
              <input value={shellCommand} onChange={(event) => setShellCommand(event.target.value)} placeholder="npm test" />
            </label>
          ) : (
            <label className="span-2">
              <span>Prompt</span>
              <textarea
                rows={5}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={DEFAULT_CODEX_PROMPT}
              />
            </label>
          )}
          {selectedWorkspace?.isGitRepo && gitRefsQuery.isLoading ? (
            <p className="muted span-2">Loading Git refs…</p>
          ) : null}
          {selectedWorkspace?.isGitRepo && gitRefsQuery.isError ? (
            <p className="muted span-2">Git refs could not be loaded right now.</p>
          ) : null}
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={!canSubmit}>
            Create task
          </button>
        </div>
      </form>
    </div>
  );
}
