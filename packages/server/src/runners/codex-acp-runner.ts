import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import type { CodexRunnerConfig } from "@workhorse/contracts";
import WebSocket from "ws";

import { AppError } from "../lib/errors.js";
import { getAvailablePort } from "../lib/net.js";
import type {
  RunnerAdapter,
  RunnerControl,
  RunnerLifecycleHooks,
  RunnerStartContext
} from "./types.js";

type JsonRpcId = number;

interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: T;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: T;
}

interface InitializeResult {
  userAgent: string;
}

interface ThreadStartResult {
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

function humanizeItemType(type: string): string {
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_/.-]+/g, " ")
    .trim();
}

function classifyItemLifecycle(
  item: Record<string, unknown> & { type: string },
  phase: "started" | "completed",
  context: { threadId: string; turnId: string }
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
    const port = await getAvailablePort();
    const listenUrl = `ws://127.0.0.1:${port}`;
    const child = spawn(
      "codex",
      ["app-server", "--listen", listenUrl],
      {
        cwd: context.workspace.rootPath,
        env: process.env
      }
    );

    child.stdout.on("data", async (chunk: Buffer) => {
      await hooks.onOutput({
        kind: "system",
        text: chunk.toString("utf8"),
        stream: "system",
        title: "Codex ACP"
      });
    });

    child.stderr.on("data", async (chunk: Buffer) => {
      await hooks.onOutput({
        kind: "system",
        text: chunk.toString("utf8"),
        stream: "system",
        title: "Codex ACP"
      });
    });

    const ws = await this.connect(listenUrl);
    const pending = new Map<JsonRpcId, PendingRequest>();
    let requestId = 0;
    let finalized = false;
    let stopRequested = false;
    let threadId = "";
    let turnId = "";

    const finalize = async (result: {
      status: "succeeded" | "failed" | "canceled";
      exitCode?: number;
      metadata?: Record<string, string>;
    }): Promise<void> => {
      if (finalized) {
        return;
      }

      finalized = true;
      ws.close();
      if (!child.killed) {
        child.kill("SIGTERM");
      }

      await hooks.onExit(result);
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

    child.on("error", async (error) => {
      await hooks.onOutput({
        kind: "system",
        text: `${error.message}\n`,
        stream: "system",
        title: "Codex ACP error"
      });
      await finalize({
        status: stopRequested ? "canceled" : "failed",
        metadata: threadId && turnId ? { threadId, turnId } : undefined
      });
    });

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
        case "item/agentMessage/delta": {
          const params = notification.params as AgentMessageDeltaNotification;
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
        case "item/assistantMessage/delta": {
          const params = notification.params as AgentMessageDeltaNotification;
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
          await hooks.onOutput({
            kind: "tool_output",
            text: params.delta,
            stream: params.stream ?? "stdout",
            title: "Tool output",
            source: notification.method
          });
          break;
        }
        case "item/commandExecution/outputDelta": {
          const params = notification.params as CommandExecutionOutputDeltaNotification;
          await hooks.onOutput({
            kind: "tool_output",
            text: params.delta,
            stream: "stdout",
            title: "Tool output",
            source: notification.method
          });
          break;
        }
        case "item/started": {
          const params = notification.params as ItemLifecycleNotification;
          const output = classifyItemLifecycle(params.item, "started", {
            threadId: params.threadId,
            turnId: params.turnId
          });
          if (output) {
            await hooks.onOutput(output);
          }
          break;
        }
        case "item/completed": {
          const params = notification.params as ItemLifecycleNotification;
          const output = classifyItemLifecycle(params.item, "completed", {
            threadId: params.threadId,
            turnId: params.turnId
          });
          if (output) {
            await hooks.onOutput(output);
          }
          break;
        }
        case "turn/completed": {
          const params = notification.params as TurnCompletedNotification;
          await finalize({
            status:
              stopRequested || params.turn.status === "interrupted"
                ? "canceled"
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
          status: stopRequested ? "canceled" : "failed",
          metadata: threadId && turnId ? { threadId, turnId } : undefined
        });
      }
    });

    child.on("exit", async () => {
      if (!finalized) {
        await finalize({
          status: stopRequested ? "canceled" : "failed",
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

    const thread = await request<ThreadStartResult>("thread/start", {
      model: config.model ?? null,
      cwd: context.workspace.rootPath,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });

    threadId = thread.thread.id;

    const turn = await request<TurnStartResult>("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: config.prompt,
          text_elements: []
        }
      ]
    });

    turnId = turn.turn.id;

    return {
      pid: child.pid ?? undefined,
      command: `codex app-server --listen ${listenUrl}`,
      metadata: {
        threadId,
        turnId
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
            // Fall through to process termination.
          }
        }

        if (!child.killed) {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 1_000).unref();
      }
    };
  }

  private async connect(url: string): Promise<WebSocket> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const socket = await new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.once("open", () => resolve(ws));
          ws.once("error", reject);
        });
        return socket;
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }

    throw new AppError(
      500,
      "CODEX_ACP_UNAVAILABLE",
      `Unable to connect to Codex ACP server: ${String(lastError)}`
    );
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
