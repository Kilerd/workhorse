import type { Thread, Workspace, WorkspaceAgent } from "@workhorse/contracts";

import type { ToolDefinition } from "./tool-registry.js";

export interface BuildCoordinatorPromptInput {
  workspace: Workspace;
  thread: Thread;
  agents: WorkspaceAgent[];
  tools: ToolDefinition[];
  /** Optional override description for the thread's primary coordinator. */
  coordinatorDescription?: string;
}

/**
 * Produces the system prompt shown to the coordinator agent at run start.
 *
 * The output has three sections, in order:
 *   1. Workspace operating rules — PR strategy, auto-approve policy, review
 *      preferences — inserted verbatim from `Workspace`.
 *   2. Agent roster — every mounted agent with BOTH descriptions (account
 *      capability + workspace-specific note) so the coordinator can delegate.
 *   3. Tool inventory — names, descriptions, and JSON schemas; the runner
 *      surfaces these through its tool-use protocol.
 *
 * The function is pure so it can be unit-tested without a live workspace.
 */
export function buildCoordinatorSystemPrompt(
  input: BuildCoordinatorPromptInput
): string {
  const { workspace, thread, agents, tools, coordinatorDescription } = input;

  const lines: string[] = [];

  lines.push(
    `You are the coordinator for workspace "${workspace.name}" (id: ${workspace.id}).`
  );
  lines.push(
    `You are bound to thread ${thread.id} (kind: ${thread.kind}). The session persists across turns; treat each new user or system message as an append to the ongoing conversation.`
  );
  lines.push("");

  lines.push("## Operating rules");
  const prStrategy = workspace.prStrategy ?? "independent";
  lines.push(`- PR strategy: ${prStrategy}`);
  lines.push(
    `- Auto-approve subtasks: ${workspace.autoApproveSubtasks ? "on" : "off"}`
  );
  lines.push(
    "- Code is a tool server. Decide *when* to call tools; do not invent state-machine shortcuts."
  );
  lines.push(
    "- Use start_task when a task should begin work; running/review columns are lifecycle state and must not be set directly."
  );
  lines.push(
    "- Every user message is a turn in this session. Pending user messages are batched between runs; act on them together."
  );
  lines.push(
    "- System events (plan approved, task finished, user rejected) arrive as system messages — treat them as triggers for the next action, not as noise."
  );
  lines.push(
    "- Reviews are description-driven: inspect each agent's account capability and workspace instructions, then explicitly choose one or more agents for review. Do not assume a fixed reviewer role."
  );
  lines.push(
    "- For multiple review perspectives, call request_task_review once per selected reviewer/focus and decide the ordering yourself."
  );
  if (coordinatorDescription) {
    lines.push("");
    lines.push("## Coordinator role");
    lines.push(coordinatorDescription);
  }
  lines.push("");

  lines.push("## Agents available in this workspace");
  if (agents.length === 0) {
    lines.push("- (none)");
  } else {
    for (const agent of agents) {
      lines.push(`- ${agent.name} (workspaceAgentId: ${agent.id})`);
      lines.push(
        `  · Account capability: ${agent.description ?? "no description provided"}`
      );
      lines.push(
        `  · Workspace instructions: ${agent.workspaceDescription ?? "no workspace-specific instructions"}`
      );
      lines.push(`  · Role in this workspace: ${agent.role}`);
    }
  }
  lines.push("");

  lines.push("## Tools");
  lines.push(
    "Each tool is atomic and has a strict JSON schema. Call them via the runner's tool-use protocol; never freehand SQL or shell."
  );
  lines.push(
    "Codex ACP exposes these as direct dynamic tools using the names below; MCP-capable runners may expose the same tools with a runner-specific prefix."
  );
  for (const tool of tools) {
    lines.push(`- \`${tool.name}\`: ${tool.description}`);
  }
  lines.push("");

  lines.push(
    "Respond with text to address the user directly, or issue tool calls to mutate the board. Do both in the same turn when useful."
  );

  return lines.join("\n");
}
