import type {
  RunnerType,
  TeamAgentMessageEvent,
  TeamTaskCreatedEvent
} from "@workhorse/contracts";

const SYSTEM_CONTEXT_MARKER = "--- SYSTEM CONTEXT ---";
const YOUR_TASK_MARKER = "--- YOUR TASK ---";
const DEFAULT_MAX_TEAM_MESSAGE_BYTES = 10 * 1024;
const MAX_COORDINATOR_SUBTASKS = 8;
const TRUNCATION_SUFFIX = "\n...[truncated]";

export interface TeamAgentContext {
  id: string;
  name: string;
  role: "coordinator" | "worker";
  runnerType: RunnerType;
  description?: string;
}

export interface CoordinatorSubtaskDraft {
  title: string;
  description: string;
  assignedAgent: string;
  dependencies: string[];
}

export interface CoordinatorChannelResult {
  reply: string;
  tasks: CoordinatorSubtaskDraft[];
}

export interface TeamMessageContext {
  fromAgentId: string;
  toAgentId?: string;
  messageType: TeamAgentMessageEvent["messageType"];
  payload: string;
}

export interface CoordinatorPromptInput {
  agents: TeamAgentContext[];
  userPrompt: string;
}

export interface SubtaskPromptInput {
  /** @deprecated Use workspaceName instead. */
  teamName?: string;
  workspaceName?: string;
  parentTaskTitle: string;
  agents: TeamAgentContext[];
  messages: TeamMessageContext[];
  subtaskTitle: string;
  subtaskDescription: string;
  userPrompt: string;
}

export class CoordinatorSubtaskParseError extends Error {}

function ensureTrimmedValue(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CoordinatorSubtaskParseError(`Coordinator subtask ${field} is required`);
  }

  return trimmed;
}

function formatAgent(agent: TeamAgentContext): string {
  const description = agent.description?.trim();
  return description
    ? `- ${agent.role}: ${agent.name} (${agent.runnerType}, ${description})`
    : `- ${agent.role}: ${agent.name} (${agent.runnerType})`;
}

function normalizeMessagePayload(payload: string): string {
  return payload.replace(/\r\n?/g, "\n").trim();
}

function trimToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    bytes += charBytes;
    end += char.length;
  }

  return value.slice(0, end).trimEnd();
}

function extractJsonCandidates(output: string): string[] {
  const normalized = output.trim();
  if (!normalized) {
    return [];
  }

  const candidates: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of normalized.matchAll(fencePattern)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }

  candidates.push(normalized);

  const firstBracket = normalized.indexOf("[");
  const lastBracket = normalized.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(normalized.slice(firstBracket, lastBracket + 1).trim());
  }

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1).trim());
  }

  return [...new Set(candidates)];
}

function parseDependencies(
  value: unknown,
  title: string
): string[] {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new CoordinatorSubtaskParseError(
      `Coordinator subtask "${title}" dependencies must be an array`
    );
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new CoordinatorSubtaskParseError(
        `Coordinator subtask "${title}" dependency #${index + 1} must be a string`
      );
    }

    return entry.trim();
  });
}

export function truncateTeamMessagePayload(
  payload: string,
  maxBytes = DEFAULT_MAX_TEAM_MESSAGE_BYTES
): string {
  const normalized = normalizeMessagePayload(payload);
  if (!normalized) {
    return "";
  }

  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }

  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
  const head = trimToBytes(normalized, Math.max(maxBytes - suffixBytes, 0));
  return `${head}${TRUNCATION_SUFFIX}`;
}

export function buildCoordinatorPrompt(input: CoordinatorPromptInput): string {
  const userPrompt = ensureTrimmedValue(input.userPrompt, "prompt");
  const agentLines = input.agents.length > 0
    ? input.agents.map(formatAgent)
    : ["- none configured"];

  return [
    SYSTEM_CONTEXT_MARKER,
    "Team agents:",
    ...agentLines,
    "",
    "Output format: JSON array of subtasks:",
    '[{ "title": "...", "description": "...", "assignedAgent": "agent-name", "dependencies": ["other-subtask-title"] }]',
    YOUR_TASK_MARKER,
    userPrompt
  ].join("\n");
}

export function buildWorkspaceChannelPrompt(input: {
  agents: TeamAgentContext[];
  transcript: string;
}): string {
  const transcript = ensureTrimmedValue(input.transcript, "transcript");
  const agentLines = input.agents.length > 0
    ? input.agents.map(formatAgent)
    : ["- none configured"];

  return [
    SYSTEM_CONTEXT_MARKER,
    "Workspace agents:",
    ...agentLines,
    "",
    "You are the workspace coordinator for channel #all.",
    "Two response modes are allowed:",
    "1. For normal conversation, reply with plain text only.",
    '2. Only when you are ready to propose new top-level tasks, reply in JSON with the exact shape: {"reply":"...", "tasks":[{ "title": "...", "description": "...", "assignedAgent": "agent-name", "dependencies": ["other-task-title"] }]}',
    "If the user is just chatting, asking questions, or clarifying scope, do not emit JSON and do not create tasks yet.",
    "Keep `reply` conversational and concise. Use exact configured agent names in `assignedAgent` whenever you emit tasks.",
    YOUR_TASK_MARKER,
    transcript
  ].join("\n");
}

function buildProposalReply(count: number): string {
  return `I drafted ${count} task${count === 1 ? "" : "s"} for approval.`;
}

export function parseCoordinatorSubtasks(output: string): CoordinatorSubtaskDraft[] {
  const candidates = extractJsonCandidates(output);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!Array.isArray(parsed)) {
        throw new CoordinatorSubtaskParseError(
          "Coordinator output must be a JSON array of subtasks"
        );
      }
      if (parsed.length > MAX_COORDINATOR_SUBTASKS) {
        throw new CoordinatorSubtaskParseError(
          `Coordinator output ${parsed.length} subtasks, maximum is ${MAX_COORDINATOR_SUBTASKS}`
        );
      }

      return parsed.map((entry, index) => {
        if (!entry || typeof entry !== "object") {
          throw new CoordinatorSubtaskParseError(
            `Coordinator subtask #${index + 1} must be an object`
          );
        }

        const record = entry as Record<string, unknown>;
        const title = ensureTrimmedValue(String(record.title ?? ""), "title");
        const description = ensureTrimmedValue(
          String(record.description ?? ""),
          "description"
        );
        const assignedAgent = ensureTrimmedValue(
          String(record.assignedAgent ?? ""),
          "assignedAgent"
        );

        return {
          title,
          description,
          assignedAgent,
          dependencies: parseDependencies(record.dependencies, title)
        };
      });
    } catch (error) {
      if (
        error instanceof CoordinatorSubtaskParseError ||
        !(lastError instanceof CoordinatorSubtaskParseError)
      ) {
        lastError = error;
      }
    }
  }

  if (lastError instanceof CoordinatorSubtaskParseError) {
    throw lastError;
  }

  throw new CoordinatorSubtaskParseError(
    "Coordinator output did not contain a valid JSON subtask array"
  );
}

export function parseCoordinatorChannelResult(
  output: string
): CoordinatorChannelResult {
  const normalized = output.trim();
  if (!normalized) {
    throw new CoordinatorSubtaskParseError("Coordinator output cannot be empty");
  }

  const candidates = extractJsonCandidates(output);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        const tasks = parseCoordinatorSubtasks(JSON.stringify(parsed));
        return {
          reply: buildProposalReply(tasks.length),
          tasks
        };
      }

      if (!parsed || typeof parsed !== "object") {
        throw new CoordinatorSubtaskParseError(
          "Coordinator output JSON must be an object or array"
        );
      }

      const record = parsed as Record<string, unknown>;
      const tasks = record.tasks == null ? [] : parseCoordinatorSubtasks(JSON.stringify(record.tasks));
      const replySource =
        typeof record.reply === "string"
          ? record.reply
          : typeof record.message === "string"
            ? record.message
            : typeof record.content === "string"
              ? record.content
              : "";
      const reply = replySource.trim();

      if (reply) {
        return { reply, tasks };
      }

      if (tasks.length > 0) {
        return {
          reply: buildProposalReply(tasks.length),
          tasks
        };
      }

      throw new CoordinatorSubtaskParseError(
        "Coordinator response JSON must include a reply string or tasks"
      );
    } catch {
      // Fall back to plain-text chat when the coordinator did not return structured JSON.
    }
  }

  return {
    reply: normalized,
    tasks: []
  };
}

export function buildSubtaskPrompt(input: SubtaskPromptInput): string {
  const teamName = ensureTrimmedValue(
    input.workspaceName ?? input.teamName ?? "",
    "workspaceName"
  );
  const parentTaskTitle = ensureTrimmedValue(input.parentTaskTitle, "parentTaskTitle");
  const subtaskTitle = ensureTrimmedValue(input.subtaskTitle, "subtaskTitle");
  const subtaskDescription = ensureTrimmedValue(
    input.subtaskDescription,
    "subtaskDescription"
  );
  const userPrompt = ensureTrimmedValue(input.userPrompt, "prompt");

  const agentLines = input.agents.length > 0
    ? input.agents.map(formatAgent)
    : ["- none configured"];
  const messageLines = input.messages.length > 0
    ? input.messages.map((message) => {
        const toLabel = message.toAgentId?.trim() || "broadcast";
        const payload = truncateTeamMessagePayload(message.payload);
        return `- [${message.messageType}] ${message.fromAgentId} -> ${toLabel}: ${payload}`;
      })
    : ["- none"];

  return [
    SYSTEM_CONTEXT_MARKER,
    `Team: ${teamName}`,
    `Parent task: ${parentTaskTitle}`,
    "Team agents:",
    ...agentLines,
    "",
    "Historical team messages:",
    ...messageLines,
    "",
    "Assigned subtask:",
    `Title: ${subtaskTitle}`,
    `Description:\n${subtaskDescription}`,
    YOUR_TASK_MARKER,
    userPrompt
  ].join("\n");
}

export function buildTeamAgentMessageEvent(input: {
  teamId: string;
  parentTaskId: string;
  fromAgentId: string;
  toAgentId?: string;
  messageType: TeamAgentMessageEvent["messageType"];
  payload: string;
}): TeamAgentMessageEvent {
  return {
    type: "team.agent.message",
    teamId: ensureTrimmedValue(input.teamId, "teamId"),
    parentTaskId: ensureTrimmedValue(input.parentTaskId, "parentTaskId"),
    fromAgentId: ensureTrimmedValue(input.fromAgentId, "fromAgentId"),
    ...(input.toAgentId?.trim() ? { toAgentId: input.toAgentId.trim() } : {}),
    messageType: input.messageType,
    payload: truncateTeamMessagePayload(input.payload)
  };
}

export function buildTeamTaskCreatedEvent(input: {
  teamId: string;
  parentTaskId: string;
  subtasks: Array<{ taskId: string; title: string; agentName: string }>;
}): TeamTaskCreatedEvent {
  return {
    type: "team.task.created",
    teamId: ensureTrimmedValue(input.teamId, "teamId"),
    parentTaskId: ensureTrimmedValue(input.parentTaskId, "parentTaskId"),
    subtasks: input.subtasks.map((subtask, index) => ({
      taskId: ensureTrimmedValue(subtask.taskId, `subtasks[${index}].taskId`),
      title: ensureTrimmedValue(subtask.title, `subtasks[${index}].title`),
      agentName: ensureTrimmedValue(
        subtask.agentName,
        `subtasks[${index}].agentName`
      )
    }))
  };
}
