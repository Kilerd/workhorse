import { useEffect, useState } from "react";
import type { CreateTaskBody, TaskColumn, Workspace } from "@workhorse/contracts";

interface WorkspaceModalProps {
  open: boolean;
  onClose(): void;
  onSubmit(values: { name: string; rootPath: string }): void;
}

interface TaskModalProps {
  open: boolean;
  workspaces: Workspace[];
  onClose(): void;
  onSubmit(values: CreateTaskBody): void;
}

export function WorkspaceModal({ open, onClose, onSubmit }: WorkspaceModalProps) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");

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
  const [prompt, setPrompt] = useState("Implement the requested task.");
  const [column, setColumn] = useState<TaskColumn>("todo");

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setWorkspaceId(workspaces[0]?.id ?? "");
      setRunnerType("codex");
      setShellCommand("npm test");
      setPrompt("Implement the requested task.");
      setColumn("todo");
    }
  }, [open, workspaces]);

  useEffect(() => {
    if (!workspaceId && workspaces[0]) {
      setWorkspaceId(workspaces[0].id);
    }
  }, [workspaceId, workspaces]);

  if (!open) {
    return null;
  }

  const canSubmit = workspaces.length > 0 && Boolean(title.trim()) && Boolean(workspaceId);

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
            column
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
            <select value={column} onChange={(event) => setColumn(event.target.value as TaskColumn)}>
              <option value="todo">todo</option>
              <option value="running">running</option>
              <option value="review">review</option>
              <option value="done">done</option>
              <option value="archived">archived</option>
            </select>
          </label>
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
                placeholder="Implement the requested task."
              />
            </label>
          )}
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
