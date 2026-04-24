import WebSocket from "ws";

import type { CodexRunnerConfig, RunStatus } from "@workhorse/contracts";

import { resolveWorkspaceCodexSettings } from "../lib/codex-settings.js";
import { classifyItemLifecycle } from "./codex-acp-runner.js";
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
  CoordinatorOutputChunk,
  CoordinatorRunHandle,
  CoordinatorRunInput,
  CoordinatorRunOutcome,
  CoordinatorRunner
} from "./session-bridge.js";

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
    text?: string;
    aggregatedOutput?: string | null;
  };
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
}

interface PendingDynamicToolCall {
  requestId: JsonRpcId;
  params: DynamicToolCallParams;
}

interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: unknown;
}

interface ActiveCommandOutputContext {
  groupId: string;
  itemId?: string;
  turnId?: string;
  threadId?: string;
}

interface CodexAcpCoordinatorRunnerOptions {
  appServer?: CodexAppServer;
}

function resolveCodexEffortConfig(
  config: CodexRunnerConfig
): Record<string, unknown> | undefined {
  if (!config.model || config.model.mode !== "builtin") {
    return undefined;
  }
  const effort = config.model.reasoningEffort;
  return effort ? { model_reasoning_effort: effort } : undefined;
}

function buildInputPayload(text: string) {
  return [
    {
      type: "text" as const,
      text,
      text_elements: []
    }
  ];
}

function renderPrompt(input: CoordinatorRunInput): string {
  const turns = input.appendMessages.map((message) => {
    const label = message.role === "system" ? "System event" : "User";
    return `${label}:\n${message.content}`;
  });
  return [input.systemPrompt, ...turns].filter(Boolean).join("\n\n");
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
    ...flattenItemText(record.aggregatedOutput),
    ...flattenItemText(record.content),
    ...flattenItemText(record.output),
    ...flattenItemText(record.message)
  ];
}

function isCommandLikeItemType(type: string | undefined): boolean {
  return Boolean(type?.toLowerCase().includes("command"));
}

function buildThreadStartParams(
  input: CoordinatorRunInput,
  config: CodexRunnerConfig
) {
  const settings = resolveWorkspaceCodexSettings(input.workspace);
  const effortConfig = resolveCodexEffortConfig(config);
  const dynamicTools = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
  return {
    model: config.model?.id ?? null,
    cwd: input.workspaceDir,
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandboxMode,
    ephemeral: false,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
    ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
    ...(effortConfig ? { config: effortConfig } : {})
  };
}

function buildThreadResumeParams(
  input: CoordinatorRunInput,
  config: CodexRunnerConfig,
  threadId: string
) {
  const settings = resolveWorkspaceCodexSettings(input.workspace);
  const effortConfig = resolveCodexEffortConfig(config);
  return {
    threadId,
    model: config.model?.id ?? null,
    cwd: input.workspaceDir,
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandboxMode,
    persistExtendedHistory: true,
    ...(effortConfig ? { config: effortConfig } : {})
  };
}

function formatDynamicToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(result, null, 2);
}

function isDynamicToolErrorResult(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      "error" in result &&
      (result as { error?: unknown }).error
  );
}

export class CodexAcpCoordinatorRunner implements CoordinatorRunner {
  private readonly appServerManager: CodexAppServer;

  public constructor(options: CodexAcpCoordinatorRunnerOptions = {}) {
    this.appServerManager = options.appServer ?? new CodexAppServerManager();
  }

  public async resumeOrStart(
    input: CoordinatorRunInput
  ): Promise<CoordinatorRunHandle> {
    const config = input.runnerConfig;
    if (config.type !== "codex") {
      throw new Error("Coordinator agent is not configured for Codex ACP");
    }

    const connection = await this.appServerManager.createConnection();
    const ws = connection.ws;
    const pending = new Map<JsonRpcId, PendingRequest>();
    const pendingDynamicToolCalls = new Map<string, PendingDynamicToolCall>();
    const chunkHandlers = new Set<(chunk: CoordinatorOutputChunk) => void>();
    const finishHandlers = new Set<(outcome: CoordinatorRunOutcome) => void>();
    const bufferedChunks: CoordinatorOutputChunk[] = [];
    let requestId = 0;
    let settled = false;
    let finalOutcome: CoordinatorRunOutcome | undefined;
    let stopRequested = false;
    let acpThreadId = "";
    let turnId = "";
    const streamedItems = new Set<string>();
    const activeCommandOutputContexts: ActiveCommandOutputContext[] = [];

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

    const emitChunk = (chunk: CoordinatorOutputChunk) => {
      if (chunkHandlers.size === 0) {
        bufferedChunks.push(chunk);
        return;
      }
      for (const handler of chunkHandlers) {
        try {
          handler(chunk);
        } catch (error) {
          console.warn("[codex-coord] chunk handler threw", error);
        }
      }
    };

    const finish = (outcome: CoordinatorRunOutcome) => {
      if (settled) return;
      settled = true;
      finalOutcome = outcome;
      try {
        ws.close();
      } catch {
        // The socket may already be closed by the ACP server.
      }
      for (const handler of finishHandlers) {
        try {
          handler(outcome);
        } catch (error) {
          console.warn("[codex-coord] finish handler threw", error);
        }
      }
    };

    const send = (
      message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse
    ): void => {
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
        emitChunk({
          type: "text",
          text: `[codex-coord] Invalid ACP message: ${String(error)}`
        });
        return;
      }

      if (("id" in message && "result" in message) || "error" in message) {
        const response = message as JsonRpcResponse;
        const pendingRequest = pending.get(response.id);
        if (!pendingRequest) return;
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
        const requestMessage = message as JsonRpcRequest;
        if (requestMessage.method === "item/tool/call") {
          const params = requestMessage.params as DynamicToolCallParams;
          const toolUseId = params.callId || String(requestMessage.id);
          pendingDynamicToolCalls.set(toolUseId, {
            requestId: requestMessage.id,
            params
          });
          emitChunk({
            type: "tool_use",
            toolUseId,
            name: params.tool,
            input: params.arguments ?? {}
          });
          return;
        }

        this.respondToServerRequest(ws, message.id, message.method);
        return;
      }

      const notification = message as JsonRpcNotification;
      switch (notification.method) {
        case "item/agentMessage/delta":
        case "item/assistantMessage/delta": {
          const params = notification.params as AgentMessageDeltaNotification;
          const streamKey = `${params.turnId}:${params.itemId}`;
          streamedItems.add(streamKey);
          if (params.delta) {
            emitChunk({
              type: "text",
              text: params.delta,
              mode: "delta",
              outputId: streamKey
            });
          }
          break;
        }
        case "command/exec/outputDelta": {
          const params = notification.params as CommandExecOutputDeltaNotification;
          if (params.delta) {
            emitChunk({
              type: "activity",
              kind: "tool_output",
              text: params.delta,
              stream: params.stream ?? "stdout",
              title: "Tool output",
              source: notification.method,
              metadata: currentCommandOutputMetadata()
            });
          }
          break;
        }
        case "item/commandExecution/outputDelta": {
          const params = notification.params as CommandExecutionOutputDeltaNotification;
          if (params.delta) {
            emitChunk({
              type: "activity",
              kind: "tool_output",
              text: params.delta,
              stream: "stdout",
              title: "Tool output",
              source: notification.method,
              metadata: currentCommandOutputMetadata()
            });
          }
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
          if (output && output.kind !== "agent" && output.kind !== "plan") {
            emitChunk({
              type: "activity",
              kind: output.kind === "tool_call" ? "tool_call" : "status",
              text: output.text,
              stream: output.stream,
              title: output.title,
              source: output.source,
              metadata: output.metadata
            });
          }
          break;
        }
        case "item/completed": {
          const params = notification.params as ItemLifecycleNotification;
          const itemId =
            typeof params.item.id === "string" ? params.item.id : undefined;
          const streamKey = itemId ? `${params.turnId}:${itemId}` : "";
          const wasStreamedAgent = Boolean(streamKey && streamedItems.has(streamKey));
          if (wasStreamedAgent) {
            streamedItems.delete(streamKey);
            break;
          }
          const type = params.item.type.toLowerCase();
          if (type.includes("assistant") || type.includes("agent")) {
            const text = [...new Set(flattenItemText(params.item))]
              .join("\n")
              .trim();
            if (text) {
              emitChunk({
                type: "text",
                text,
                mode: "message",
                outputId: streamKey || undefined
              });
            }
            if (streamKey) {
              streamedItems.delete(streamKey);
            }
            break;
          }

          const output = classifyItemLifecycle(params.item, "completed", {
            threadId: params.threadId,
            turnId: params.turnId
          });
          if (output && output.kind !== "agent" && output.kind !== "plan") {
            emitChunk({
              type: "activity",
              kind: output.kind === "tool_call" ? "tool_call" : "status",
              text: output.text,
              stream: output.stream,
              title: output.title,
              source: output.source,
              metadata: output.metadata
            });
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
            streamedItems.delete(streamKey);
          }
          break;
        }
        case "turn/completed": {
          const params = notification.params as TurnCompletedNotification;
          const status: RunStatus = stopRequested
            ? "canceled"
            : params.turn.status === "interrupted"
              ? "interrupted"
              : params.turn.status === "completed"
                ? "succeeded"
                : "failed";
          finish({
            status,
            error:
              status === "failed"
                ? (params.turn.error?.message ?? "Codex ACP turn failed")
                : undefined
          });
          break;
        }
        case "error":
          emitChunk({
            type: "text",
            text: "[codex-coord] Codex ACP emitted an error notification."
          });
          break;
        default:
          break;
      }
    });

    ws.on("error", (error: Error) => {
      emitChunk({ type: "text", text: `[codex-coord] ${error.message}` });
    });

    ws.on("close", () => {
      if (!settled) {
        finish({
          status: stopRequested ? "canceled" : turnId ? "interrupted" : "failed"
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

    let resumed = false;
    if (input.sessionKey) {
      try {
        const thread = await request<ThreadSessionResult>(
          "thread/resume",
          buildThreadResumeParams(input, config, input.sessionKey)
        );
        acpThreadId = thread.thread.id;
        resumed = true;
      } catch (error) {
        emitChunk({
          type: "text",
          text:
            `Unable to resume previous Codex session ${input.sessionKey}: ` +
            `${error instanceof Error ? error.message : String(error)}\n` +
            "Starting a new Codex session instead."
        });
      }
    }

    if (!acpThreadId) {
      const thread = await request<ThreadSessionResult>(
        "thread/start",
        buildThreadStartParams(input, config)
      );
      acpThreadId = thread.thread.id;
    }

    if (!resumed || input.sessionKey !== acpThreadId) {
      emitChunk({ type: "session_key", key: acpThreadId });
    }

    console.log(
      `[codex-coord] turn thread=${input.threadId} acp=${acpThreadId} resume=${resumed ? "yes" : "no"} msgs=${input.appendMessages.length} tools=${input.tools.length}`
    );

    const turn = await request<TurnStartResult>("turn/start", {
      threadId: acpThreadId,
      input: buildInputPayload(renderPrompt(input))
    });
    turnId = turn.turn.id;

    return {
      runId: input.runId,
      onChunk(handler) {
        chunkHandlers.add(handler);
        for (const chunk of bufferedChunks.splice(0)) {
          handler(chunk);
        }
        return () => {
          chunkHandlers.delete(handler);
        };
      },
      onFinish(handler) {
        finishHandlers.add(handler);
        if (finalOutcome) {
          setImmediate(() => handler(finalOutcome!));
        }
        return () => {
          finishHandlers.delete(handler);
        };
      },
      async submitToolResult(resultInput) {
        const pendingToolCall = pendingDynamicToolCalls.get(resultInput.toolUseId);
        if (!pendingToolCall) {
          return;
        }
        pendingDynamicToolCalls.delete(resultInput.toolUseId);
        send({
          jsonrpc: "2.0",
          id: pendingToolCall.requestId,
          result: {
            success: !isDynamicToolErrorResult(resultInput.result),
            contentItems: [
              {
                type: "inputText",
                text: formatDynamicToolResult(resultInput.result)
              }
            ]
          }
        });
      },
      async cancel() {
        stopRequested = true;
        if (ws.readyState === WebSocket.OPEN && acpThreadId && turnId) {
          try {
            await request("turn/interrupt", {
              threadId: acpThreadId,
              turnId
            });
          } catch {
            // Close handling will mark the run interrupted/canceled.
          }
        }
      }
    };
  }

  private respondToServerRequest(
    socket: WebSocket,
    id: JsonRpcId,
    method: string
  ): void {
    let result: unknown;
    switch (method) {
      case "item/commandExecution/requestApproval":
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
