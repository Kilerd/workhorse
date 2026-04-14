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
      lastError = error;
    }
  }

  if (lastError instanceof CoordinatorSubtaskParseError) {
    throw lastError;
  }

  throw new CoordinatorSubtaskParseError(
    "Coordinator output did not contain a valid JSON subtask array"
  );
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
