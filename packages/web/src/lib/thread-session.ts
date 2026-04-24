import type {
  Task,
  Thread,
  Workspace,
  WorkspaceGitStatusData
} from "@workhorse/contracts";

export interface ThreadSessionContext {
  worktreePath: string | null;
  branchName: string | null;
}

interface ResolveThreadSessionContextInput {
  thread?: Thread | null;
  workspace?: Workspace | null;
  task?: Task | null;
  workspaceGitStatus?: WorkspaceGitStatusData | null;
}

export function resolveThreadSessionContext(
  input: ResolveThreadSessionContextInput
): ThreadSessionContext | null {
  const { thread, workspace, task, workspaceGitStatus } = input;
  if (!thread || !workspace) {
    return null;
  }

  if (thread.kind === "task") {
    return {
      worktreePath: task?.worktree.path?.trim() || null,
      branchName: workspace.isGitRepo ? task?.worktree.branchName ?? null : null
    };
  }

  return {
    worktreePath: workspace.rootPath,
    branchName: workspace.isGitRepo ? workspaceGitStatus?.branch ?? null : null
  };
}
