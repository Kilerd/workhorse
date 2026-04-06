import {
  resolveTemplate,
  resolveWorkspacePromptTemplate,
  type CodexRunnerConfig
} from "@workhorse/contracts";
import WebSocket from "ws";

import { resolveWorkspaceCodexSettings } from "../lib/codex-settings.js";
import { AppError } from "../lib/errors.js";
import { extractGitHubPullRequestUrl } from "../lib/github.js";
import {
  CodexAppServerManager,
  type CodexAppServer
} from "./codex-app-server-manager.js";
import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse
} from "./json-rpc.js";
import type {
  RunnerAdapter,
  RunnerControl,
  RunnerLifecycleHooks,
  RunnerStartContext
} from "./types.js";

interface InitializeResult {
  userAgent: string;
}

interface ThreadSessionResult {
  thread: {
    id: string;
  };
}

interface TurnStartResult {
  turn: {
    id: string;
  };
}

interface TurnSteerResult {
  turnId: string;
}

interface TurnState {
  id: string;
  status: "completed" | "failed" | "interrupted" | "inProgress";
  error?: {
    message: string;
  } | null;
}

interface TurnCompletedNotification {
  threadId: string;
  turn: TurnState;
}

interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

interface CommandExecOutputDeltaNotification {
  stream?: "stdout" | "stderr";
  delta: string;
}

interface CommandExecutionOutputDeltaNotification {
  delta: string;
}

interface ItemLifecycleNotification {
  threadId: string;
  turnId: string;
  item: Record<string, unknown> & {
    type: string;
    aggregatedOutput?: string | null;
    text?: string;
    status?: string;
    exitCode?: number | null;
  };
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
}

interface ActiveCommandOutputContext {
  groupId: string;
  itemId?: string;
  turnId?: string;
  threadId?: string;
}

function flattenItemText(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenItemText(entry));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  return [
    ...flattenItemText(record.text),
    ...flattenItemText(record.command),
    ...flattenItemText(record.aggregatedOutput),
    ...flattenItemText(record.title),
    ...flattenItemText(record.name),
    ...flattenItemText(record.summary),
    ...flattenItemText(record.content),
    ...flattenItemText(record.output),
    ...flattenItemText(record.message)
  ];
}

function flattenToolSummaryText(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const direct = [
    ...flattenItemText(record.command),
    ...flattenItemText(record.title),
    ...flattenItemText(record.name),
    ...flattenItemText(record.summary)
  ];

  if (direct.length > 0) {
    return direct;
  }

  if (typeof record.text === "string" && record.text.trim()) {
    const firstLine = record.text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);

    return firstLine ? [firstLine] : [];
  }

  return [];
}

function summarizeItem(item: Record<string, unknown>): string {
  const text = [...new Set(flattenItemText(item))].join("\n").trim();
  if (text) {
    return text;
  }

  const details: string[] = [];
  if (typeof item.status === "string") {
    details.push(`status: ${item.status}`);
  }
  if (typeof item.exitCode === "number") {
    details.push(`exit code: ${item.exitCode}`);
  }
  return details.join(" · ");
}

function summarizeToolItem(item: Record<string, unknown>): string {
  const text = [...new Set(flattenToolSummaryText(item))].join("\n").trim();
  if (text) {
    return text;
  }

  const details: string[] = [];
  if (typeof item.status === "string") {
    details.push(`status: ${item.status}`);
  }
  if (typeof item.exitCode === "number") {
    details.push(`exit code: ${item.exitCode}`);
  }
  return details.join(" · ");
}

function humanizeItemType(type: string): string {
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_/.-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildItemStreamKey(context: { turnId: string; itemId?: string }): string | null {
  if (!context.turnId || !context.itemId) {
    return null;
  }

  return `${context.turnId}:${context.itemId}`;
}

function isCommandLikeItemType(type: string | undefined): boolean {
  return Boolean(type?.toLowerCase().includes("command"));
}

function buildGitRequirementsPrompt(context: RunnerStartContext): string {
  const description = context.task.description.trim();
  const plan = context.task.plan?.trim();
  const prBodyParts = [
    "## Summary",
    description ? `> ${context.task.title}` : context.task.title,
    ...(plan
      ? [
          "",
          "## Plan",
          plan
        ]
      : []),
    "",
    "## Changes",
    "<!-- List the concrete changes you made, one bullet per file or logical unit. -->"
  ];

  return [
    "Git requirements:",
    `- Work on branch \`${context.task.worktree.branchName}\` from \`${context.task.worktree.baseRef}\`.`,
    "- You are responsible for creating any commits, pushing the branch, and opening or updating the GitHub PR yourself before finishing.",
    "- Use Conventional Commits for commit messages.",
    "- When creating or updating the PR, write a thorough description that includes:",
    "  - A summary of the motivation and what changed",
    "  - The implementation plan (if one was provided above)",
    "  - A concrete list of every file changed and why",
    "  - How to verify / test the changes",
    `- Use the following as a starting template for the PR body, then fill in the Changes section with your actual modifications:\n\`\`\`\n${prBodyParts.join("\n")}\n\`\`\``,
    "- Mention the PR URL in your final response."
  ].join("\n");
}

export function classifyItemLifecycle(
  item: Record<string, unknown> & { type: string },
  phase: "started" | "completed",
  context: { threadId: string; turnId: string },
  options?: { skipAgentLifecycle?: boolean }
):
  | {
      kind: "agent" | "tool_call" | "plan" | "status";
      text: string;
      stream: "stdout" | "stderr" | "system";
      title: string;
      source: string;
      metadata?: Record<string, string>;
    }
  | null {
  const type = item.type;
  if (type === "userMessage") {
    return null;
  }

  const normalized = type.toLowerCase();
  const summary = summarizeItem(item);
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const lifecycleMetadata = {
    ...(itemId
      ? {
          groupId: `item:${context.turnId}:${itemId}`,
          itemId
        }
      : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    ...(context.threadId ? { threadId: context.threadId } : {})
  };

  if (normalized.includes("reason")) {
    return {
      kind: "plan",
      text: summary || (phase === "started" ? "Planning started." : "Planning updated."),
      stream: "system",
      title: phase === "started" ? "Plan started" : "Plan updated",
      source: `item/${phase}`,
      metadata: {
        itemType: type,
        phase,
        ...lifecycleMetadata
      }
    };
  }

  if (normalized.includes("command") || normalized.includes("tool")) {
    const summary = summarizeToolItem(item);
    const metadata: Record<string, string> = {
      itemType: type,
      phase,
      ...lifecycleMetadata
    };
    if (typeof item.status === "string") {
      metadata.status = item.status;
    }
    if (typeof item.exitCode === "number") {
      metadata.exitCode = String(item.exitCode);
    }

    return {
      kind: "tool_call",
      text:
        summary ||
        `${humanizeItemType(type)} ${phase === "started" ? "started" : "completed"}.`,
      stream: "system",
      title:
        phase === "started"
          ? `${humanizeItemType(type)} started`
          : `${humanizeItemType(type)} completed`,
      source: `item/${phase}`,
      metadata
    };
  }

  if (normalized.includes("assistant") || normalized.includes("agent")) {
    if (phase === "started" || options?.skipAgentLifecycle) {
      return null;
    }

    return {
      kind: "agent",
      text: summary || "Agent updated the response.",
      stream: "stdout",
      title: "Agent response",
      source: `item/${phase}`,
      metadata: {
        itemType: type,
        phase,
        ...lifecycleMetadata
      }
    };
  }

  return {
    kind: "status",
    text:
      summary ||
      `${humanizeItemType(type)} ${phase === "started" ? "started" : "completed"}.`,
    stream: "system",
    title: humanizeItemType(type),
    source: `item/${phase}`,
    metadata: {
      itemType: type,
      phase,
      ...lifecycleMetadata
    }
  };
}

export class CodexAcpRunner implements RunnerAdapter {
  public readonly type = "codex" as const;

  public constructor(
    private readonly appServerManager: CodexAppServer = new CodexAppServerManager()
  ) {}

  public async start(
    context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl> {
    const config = context.task.runnerConfig;
    if (config.type !== "codex") {
      throw new AppError(400, "INVALID_RUNNER_CONFIG", "Task is not configured for Codex ACP execution");
    }

    return this.startSession(context, config as CodexRunnerConfig, hooks);
  }

  private async startSession(
    context: RunnerStartContext,
    config: CodexRunnerConfig,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl> {
    const connection = await this.appServerManager.createConnection();
    const ws = connection.ws;
    const pending = new Map<JsonRpcId, PendingRequest>();
    let requestId = 0;
    let finalized = false;
    let stopRequested = false;
    let threadId = "";
    let turnId = "";
    const streamedAgentItems = new Set<string>();
    const activeCommandOutputContexts: ActiveCommandOutputContext[] = [];
    const capturedText: string[] = [];

    const appendCapturedText = (value: string | undefined): void => {
      if (!value?.trim()) {
        return;
      }

      capturedText.push(value);
    };

    const currentCommandOutputMetadata = (): Record<string, string> | undefined => {
      const current = activeCommandOutputContexts.at(-1);
      if (!current) {
        return undefined;
      }

      return {
        groupId: current.groupId,
        ...(current.itemId ? { itemId: current.itemId } : {}),
        ...(current.turnId ? { turnId: current.turnId } : {}),
        ...(current.threadId ? { threadId: current.threadId } : {})
      };
    };

    const finalize = async (result: {
      status: "succeeded" | "failed" | "interrupted" | "canceled";
      exitCode?: number;
      metadata?: Record<string, string>;
    }): Promise<void> => {
      if (finalized) {
        return;
      }

      finalized = true;
      ws.close();

      await hooks.onExit({
        ...result,
        metadata: this.attachPullRequestMetadata(result.metadata, capturedText)
      });
    };

    const send = (message: JsonRpcRequest | JsonRpcNotification): void => {
      ws.send(JSON.stringify(message));
    };

    const request = async <T>(method: string, params?: unknown): Promise<T> => {
      requestId += 1;
      const id = requestId;
      send({
        jsonrpc: "2.0",
        id,
        method,
        params
      });

      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    };

    ws.on("message", async (rawMessage: WebSocket.RawData) => {
      let message: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;

      try {
        message = JSON.parse(rawMessage.toString());
      } catch (error) {
        await hooks.onOutput({
          kind: "system",
          text: `Invalid ACP message: ${String(error)}\n`,
          stream: "system",
          title: "Codex ACP error"
        });
        return;
      }

      if (("id" in message && "result" in message) || "error" in message) {
        const response = message as JsonRpcResponse;
        const pendingRequest = pending.get(response.id);
        if (!pendingRequest) {
          return;
        }

        pending.delete(response.id);
        if (response.error) {
          pendingRequest.reject(
            new Error(response.error.message ?? "ACP request failed")
          );
        } else {
          pendingRequest.resolve(response.result);
        }
        return;
      }

      if ("id" in message && "method" in message) {
        const serverRequest = message as JsonRpcRequest;
        await this.respondToServerRequest(ws, serverRequest.id, serverRequest.method);
        return;
      }

      const notification = message as JsonRpcNotification;
      switch (notification.method) {
        case "item/agentMessage/delta":
        case "item/assistantMessage/delta": {
          const params = notification.params as AgentMessageDeltaNotification;
          appendCapturedText(params.delta);
          const streamKey = buildItemStreamKey({
            turnId: params.turnId,
            itemId: params.itemId
          });
          if (streamKey) {
            streamedAgentItems.add(streamKey);
          }
          await hooks.onOutput({
            kind: "agent",
            text: params.delta,
            stream: "stdout",
            title: "Agent output",
            source: notification.method,
            metadata: {
              groupId: `agent:${params.turnId}:${params.itemId}`,
              itemId: params.itemId,
              turnId: params.turnId,
              threadId: params.threadId
            }
          });
          break;
        }
        case "command/exec/outputDelta": {
          const params = notification.params as CommandExecOutputDeltaNotification;
          appendCapturedText(params.delta);
          await hooks.onOutput({
            kind: "tool_output",
            text: params.delta,
            stream: params.stream ?? "stdout",
            title: "Tool output",
            source: notification.method,
            metadata: currentCommandOutputMetadata()
          });
          break;
        }
        case "item/commandExecution/outputDelta": {
          const params = notification.params as CommandExecutionOutputDeltaNotification;
          appendCapturedText(params.delta);
          await hooks.onOutput({
            kind: "tool_output",
            text: params.delta,
            stream: "stdout",
            title: "Tool output",
            source: notification.method,
            metadata: currentCommandOutputMetadata()
          });
          break;
        }
        case "item/started": {
          const params = notification.params as ItemLifecycleNotification;
          const output = classifyItemLifecycle(params.item, "started", {
            threadId: params.threadId,
            turnId: params.turnId
          });
          if (
            output?.kind === "tool_call" &&
            isCommandLikeItemType(output.metadata?.itemType) &&
            output.metadata?.groupId
          ) {
            activeCommandOutputContexts.push({
              groupId: output.metadata.groupId,
              itemId: output.metadata.itemId,
              turnId: output.metadata.turnId,
              threadId: output.metadata.threadId
            });
          }
          if (output) {
            await hooks.onOutput(output);
          }
          break;
        }
        case "item/completed": {
          const params = notification.params as ItemLifecycleNotification;
          const streamKey = buildItemStreamKey({
            turnId: params.turnId,
            itemId: typeof params.item.id === "string" ? params.item.id : undefined
          });
          const output = classifyItemLifecycle(params.item, "completed", {
            threadId: params.threadId,
            turnId: params.turnId
          }, {
            skipAgentLifecycle: streamKey ? streamedAgentItems.has(streamKey) : false
          });
          if (output) {
            appendCapturedText(output.text);
            await hooks.onOutput(output);
          }
          if (output?.kind === "tool_call" && output.metadata?.groupId) {
            let contextIndex = -1;
            for (let index = activeCommandOutputContexts.length - 1; index >= 0; index -= 1) {
              const context = activeCommandOutputContexts[index];
              if (context?.groupId === output.metadata.groupId) {
                contextIndex = index;
                break;
              }
            }
            if (contextIndex >= 0) {
              activeCommandOutputContexts.splice(contextIndex, 1);
            }
          }
          if (streamKey) {
            streamedAgentItems.delete(streamKey);
          }
          break;
        }
        case "turn/completed": {
          const params = notification.params as TurnCompletedNotification;
          await finalize({
            status: stopRequested
              ? "canceled"
              : params.turn.status === "interrupted"
                ? "interrupted"
                : params.turn.status === "completed"
                  ? "succeeded"
                  : "failed",
            metadata: {
              threadId: params.threadId,
              turnId: params.turn.id
            }
          });
          break;
        }
        case "error": {
          await hooks.onOutput({
            kind: "system",
            text: "Codex ACP emitted an error notification.\n",
            stream: "system",
            title: "Codex ACP error",
            source: notification.method
          });
          break;
        }
        default:
          break;
      }
    });

    ws.on("error", async (error: Error) => {
      await hooks.onOutput({
        kind: "system",
        text: `${error.message}\n`,
        stream: "system",
        title: "WebSocket error"
      });
    });

    ws.on("close", async () => {
      if (!finalized) {
        await finalize({
          status: stopRequested ? "canceled" : threadId && turnId ? "interrupted" : "failed",
          metadata: threadId && turnId ? { threadId, turnId } : undefined
        });
      }
    });

    await request<InitializeResult>("initialize", {
      clientInfo: {
        name: "workhorse",
        title: "Workhorse",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    send({
      jsonrpc: "2.0",
      method: "initialized"
    });

    const thread = await this.startOrResumeThread(request, context, config, hooks);
    threadId = thread.threadId;

    const turnParams = this.buildTurnStartParams(context, config, threadId, thread.resumed);
    const promptText = turnParams.input
      .filter((item: { type: string }) => item.type === "text")
      .map((item: { text: string }) => item.text)
      .join("\n\n");

    if (promptText) {
      await hooks.onOutput({
        kind: "user",
        text: `${promptText}\n`,
        stream: "system",
        title: "Prompt",
        source: "Codex ACP"
      });
    }

    const turn = await request<TurnStartResult>(
      "turn/start",
      turnParams
    );

    turnId = turn.turn.id;

    return {
      pid: connection.pid,
      command: connection.command,
      metadata: {
        threadId,
        turnId
      },
      sendInput: async (input) => {
        const text = input.trim();
        if (!text) {
          return;
        }

        if (finalized || stopRequested) {
          throw new AppError(409, "CODEX_SESSION_UNAVAILABLE", "Codex session is no longer active");
        }

        if (ws.readyState !== WebSocket.OPEN) {
          throw new AppError(409, "CODEX_SESSION_UNAVAILABLE", "Codex session is disconnected");
        }

        if (!threadId) {
          throw new AppError(409, "CODEX_THREAD_UNAVAILABLE", "Codex thread is unavailable");
        }

        const inputPayload = this.buildUserInputPayload(text);

        if (turnId) {
          const response = await request<TurnSteerResult>("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: inputPayload
          });
          turnId = response.turnId;
        } else {
          const response = await request<TurnStartResult>("turn/start", {
            threadId,
            input: inputPayload
          });
          turnId = response.turn.id;
        }

        return {
          metadata: {
            threadId,
            turnId
          }
        };
      },
      async stop() {
        stopRequested = true;
        if (ws.readyState === WebSocket.OPEN && threadId && turnId) {
          try {
            await request("turn/interrupt", {
              threadId,
              turnId
            });
          } catch {
            // Let websocket close handling mark the session interrupted if needed.
          }
        }
      }
    };
  }

  private buildPrompt(context: RunnerStartContext, config: CodexRunnerConfig): string {
    const description = context.task.description.trim();
    const plan = context.task.plan?.trim();
    const sections = [
      `Task: ${context.task.title}`
    ];

    if (description) {
      sections.push(`Task description:\n${description}`);
    }

    if (plan) {
      sections.push(`Implementation plan:\n${plan}`);
    }

    sections.push(
      resolveTemplate(
        resolveWorkspacePromptTemplate("coding", context.workspace.promptTemplates),
        {
          taskPrompt: config.prompt.trim(),
          taskTitle: context.task.title,
          taskDescription: description,
          taskPlan: plan ?? "",
          workingDirectory: context.workspace.rootPath,
          baseRef: context.task.worktree.baseRef,
          branchName: context.task.worktree.branchName,
          gitRequirements: context.workspace.isGitRepo
            ? buildGitRequirementsPrompt(context)
            : ""
        }
      )
    );

    return sections.filter(Boolean).join("\n\n");
  }

  private buildFreshThreadFollowUpPrompt(
    context: RunnerStartContext,
    config: CodexRunnerConfig
  ): string {
    const userInput = context.inputText?.trim();
    if (!userInput) {
      return this.buildPrompt(context, config);
    }

    return [
      this.buildPrompt(context, config),
      "User follow-up:",
      userInput
    ].join("\n\n");
  }

  private buildUserInputPayload(text: string) {
    return [
      {
        type: "text" as const,
        text,
        text_elements: []
      }
    ];
  }

  private attachPullRequestMetadata(
    metadata: Record<string, string> | undefined,
    capturedText: string[]
  ): Record<string, string> | undefined {
    const prUrl =
      metadata?.prUrl ??
      extractGitHubPullRequestUrl(capturedText.join("\n"));
    if (!prUrl) {
      return metadata;
    }

    return {
      ...(metadata ?? {}),
      prUrl
    };
  }

  private resolvePreviousThreadId(context: RunnerStartContext): string | null {
    if (context.previousRun?.runnerType !== "codex") {
      return null;
    }

    const threadId = context.previousRun.metadata?.threadId?.trim();
    return threadId ? threadId : null;
  }

  private buildThreadStartParams(context: RunnerStartContext, config: CodexRunnerConfig) {
    const settings = resolveWorkspaceCodexSettings(context.workspace);

    return {
      model: config.model ?? null,
      cwd: context.workspace.rootPath,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.sandboxMode,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    };
  }

  private buildThreadResumeParams(
    context: RunnerStartContext,
    config: CodexRunnerConfig,
    threadId: string
  ) {
    const settings = resolveWorkspaceCodexSettings(context.workspace);

    return {
      threadId,
      model: config.model ?? null,
      cwd: context.workspace.rootPath,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.sandboxMode,
      persistExtendedHistory: true
    };
  }

  private buildTurnStartParams(
    context: RunnerStartContext,
    config: CodexRunnerConfig,
    threadId: string,
    resumed: boolean
  ) {
    const turnInput =
      context.inputText?.trim() && resumed
        ? context.inputText.trim()
        : this.buildFreshThreadFollowUpPrompt(context, config);

    return {
      threadId,
      input: this.buildUserInputPayload(turnInput)
    };
  }

  private async startOrResumeThread(
    request: <T>(method: string, params?: unknown) => Promise<T>,
    context: RunnerStartContext,
    config: CodexRunnerConfig,
    hooks: RunnerLifecycleHooks
  ): Promise<{ threadId: string; resumed: boolean }> {
    const previousThreadId = this.resolvePreviousThreadId(context);
    if (previousThreadId) {
      try {
        const resumed = await request<ThreadSessionResult>(
          "thread/resume",
          this.buildThreadResumeParams(context, config, previousThreadId)
        );
        await hooks.onOutput({
          kind: "system",
          text: `Resumed previous Codex session ${resumed.thread.id}.\n`,
          stream: "system",
          title: "Codex ACP"
        });
        return {
          threadId: resumed.thread.id,
          resumed: true
        };
      } catch (error) {
        await hooks.onOutput({
          kind: "system",
          text:
            `Unable to resume previous Codex session ${previousThreadId}: ` +
            `${error instanceof Error ? error.message : String(error)}\n` +
            "Starting a new Codex session instead.\n",
          stream: "system",
          title: "Codex ACP"
        });
      }
    }

    const started = await request<ThreadSessionResult>(
      "thread/start",
      this.buildThreadStartParams(context, config)
    );

    return {
      threadId: started.thread.id,
      resumed: false
    };
  }

  private async respondToServerRequest(
    socket: WebSocket,
    id: JsonRpcId,
    method: string
  ): Promise<void> {
    let result: unknown;

    switch (method) {
      case "item/commandExecution/requestApproval":
        result = { decision: "acceptForSession" };
        break;
      case "item/fileChange/requestApproval":
        result = { decision: "acceptForSession" };
        break;
      case "item/permissions/requestApproval":
        result = { permissions: {}, scope: "session" };
        break;
      case "applyPatchApproval":
      case "execCommandApproval":
        result = { decision: "approved_for_session" };
        break;
      case "item/tool/requestUserInput":
        result = { answers: {} };
        break;
      default:
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Unsupported server request: ${method}`
            }
          })
        );
        return;
    }

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result
      })
    );
  }
}
