import type { RunStatus, RunnerConfig, Workspace } from "@workhorse/contracts";

/**
 * A message passed to a coordinator session as a new turn. `role='user'` is
 * the typical user-facing turn; `role='system'` carries injected events
 * (plan approved, task finished) that we still want to inline as turns.
 */
export interface CoordinatorInputMessage {
  role: "user" | "system";
  content: string;
}

/**
 * Structured output chunk streamed from a coordinator run.
 *
 * `tool_use` chunks carry a tool invocation the agent issued; the Orchestrator
 * routes them into the ToolRegistry. `text` chunks carry free-form assistant
 * output that is surfaced back to the thread as a `kind='chat'` message.
 * `outputId` identifies the runner-level assistant output item. Chunks with
 * the same output id are continuations; a new id is a new assistant paragraph.
 * `mode='delta'` means the text is a streaming fragment that should be
 * appended to the current in-flight assistant message. `mode='message'`
 * means the runner is surfacing a complete update and the message boundary
 * should be preserved in thread history.
 * `session_key` carries the runner-level session id (claude `--resume` id,
 * codex session id) that should be persisted to `AgentSession.runnerSessionKey`.
 */
export type CoordinatorOutputChunk =
  | {
      type: "text";
      text: string;
      mode?: "delta" | "message";
      outputId?: string;
    }
  | {
      type: "tool_use";
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | { type: "session_key"; key: string };

export interface CoordinatorRunOutcome {
  status: RunStatus;
  exitCode?: number;
  error?: string;
}

/**
 * Handle to an in-flight coordinator run. The Orchestrator keeps one live at
 * a time per thread.
 */
export interface CoordinatorRunHandle {
  readonly runId: string;
  onChunk(handler: (chunk: CoordinatorOutputChunk) => void): () => void;
  onFinish(handler: (outcome: CoordinatorRunOutcome) => void): () => void;
  /** Reply a tool result into the running session. */
  submitToolResult(input: { toolUseId: string; result: unknown }): Promise<void>;
  /** Ask the runner to stop. Resolves when the underlying process exits. */
  cancel(): Promise<void>;
}

export interface CoordinatorRunInput {
  runId: string;
  threadId: string;
  workspaceId: string;
  agentId: string;
  runnerConfig: RunnerConfig;
  workspace: Workspace;
  workspaceDir: string;
  systemPrompt: string;
  /**
   * Previously-stored session key (claude `--resume`, codex session id).
   * `undefined` → start a fresh session and report the new key via a
   * `session_key` chunk.
   */
  sessionKey?: string;
  appendMessages: CoordinatorInputMessage[];
  /**
   * Tool definitions the runner should expose to the model. The Orchestrator
   * sources these from `ToolRegistry.list()`.
   */
  tools: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
}

/**
 * Minimal contract the Orchestrator needs to drive a coordinator turn.
 *
 * Real adapters for claude-cli and codex-acp implement this on top of their
 * existing session machinery (`--resume`, ACP session handle). A no-op stub
 * is provided for tests and for the shell runner (which has no session).
 */
export interface CoordinatorRunner {
  resumeOrStart(input: CoordinatorRunInput): Promise<CoordinatorRunHandle>;
}
