import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  HealthCodexPlanType,
  HealthCodexQuotaData,
  HealthCodexQuotaWindowData
} from "@workhorse/contracts";
import WebSocket from "ws";

import { AppError } from "../lib/errors.js";
import { getAvailablePort } from "../lib/net.js";

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface AppServerRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface AppServerRateLimitSnapshot {
  limitId?: string | null;
  planType?: HealthCodexPlanType | null;
  primary?: AppServerRateLimitWindow | null;
  secondary?: AppServerRateLimitWindow | null;
}

interface AppServerRateLimitsResult {
  rateLimits?: AppServerRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, AppServerRateLimitSnapshot> | null;
}

function isChildAlive(child: ChildProcessWithoutNullStreams | undefined): boolean {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeQuotaWindow(
  window: AppServerRateLimitWindow | null | undefined
): HealthCodexQuotaWindowData | undefined {
  if (!window) {
    return undefined;
  }

  return {
    usedPercent: clampPercent(window.usedPercent),
    remainingPercent: clampPercent(100 - window.usedPercent),
    ...(typeof window.windowDurationMins === "number"
      ? { windowDurationMins: window.windowDurationMins }
      : {}),
    ...(typeof window.resetsAt === "number"
      ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() }
      : {})
  };
}

export interface CodexAppServerConnection {
  ws: WebSocket;
  pid?: number;
  command: string;
}

export interface CodexAppServer {
  initialize(): Promise<void>;
  createConnection(): Promise<CodexAppServerConnection>;
  readAccountRateLimits(): Promise<HealthCodexQuotaData | null>;
}

export class CodexAppServerManager implements CodexAppServer {
  private child?: ChildProcessWithoutNullStreams;

  private listenUrl?: string;

  private startupPromise?: Promise<void>;

  public async initialize(): Promise<void> {
    await this.ensureReady();
  }

  public async createConnection(): Promise<CodexAppServerConnection> {
    await this.ensureReady();
    const listenUrl = this.listenUrl;
    const activeChild = this.child;

    if (!listenUrl || !activeChild || !isChildAlive(activeChild)) {
      throw new AppError(500, "CODEX_ACP_UNAVAILABLE", "Codex app-server is unavailable");
    }

    const ws = await this.connect(listenUrl);

    return {
      ws,
      pid: activeChild.pid ?? undefined,
      command: `codex app-server --listen ${listenUrl}`
    };
  }

  public async readAccountRateLimits(): Promise<HealthCodexQuotaData | null> {
    return this.withInitializedConnection(async (request) => {
      const result = await request<AppServerRateLimitsResult>("account/rateLimits/read");
      const snapshot = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
      if (!snapshot) {
        return null;
      }

      const primary = normalizeQuotaWindow(snapshot.primary);
      const secondary = normalizeQuotaWindow(snapshot.secondary);

      return {
        ...(snapshot.limitId ? { limitId: snapshot.limitId } : {}),
        ...(snapshot.planType ? { planType: snapshot.planType } : {}),
        ...(primary ? { primary } : {}),
        ...(secondary ? { secondary } : {})
      };
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.listenUrl && isChildAlive(this.child)) {
      return;
    }

    if (!this.startupPromise) {
      this.startupPromise = this.startServer();
    }

    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = undefined;
    }
  }

  private async startServer(): Promise<void> {
    const port = await getAvailablePort();
    const listenUrl = `ws://127.0.0.1:${port}`;
    const child = spawn("codex", ["app-server", "--listen", listenUrl], {
      cwd: process.cwd(),
      env: process.env
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (process.env.WORKHORSE_LOG_CODEX_APP_SERVER === "1") {
        process.stdout.write(`[codex-app-server] ${chunk.toString("utf8")}`);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (process.env.WORKHORSE_LOG_CODEX_APP_SERVER === "1") {
        process.stderr.write(`[codex-app-server] ${chunk.toString("utf8")}`);
      }
    });

    child.on("error", (error) => {
      if (this.child === child) {
        this.child = undefined;
        this.listenUrl = undefined;
      }

      if (process.env.WORKHORSE_LOG_CODEX_APP_SERVER === "1") {
        console.error("Codex app-server process error");
        console.error(error);
      }
    });

    child.on("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.listenUrl = undefined;
      }
    });

    try {
      const probe = await this.connect(listenUrl);
      probe.close();
    } catch (error) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }

      throw new AppError(
        500,
        "CODEX_ACP_UNAVAILABLE",
        `Unable to connect to Codex ACP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.child = child;
    this.listenUrl = listenUrl;
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

    throw new Error(String(lastError));
  }

  private async withInitializedConnection<T>(
    operation: (
      request: <TResponse>(method: string, params?: unknown) => Promise<TResponse>
    ) => Promise<T>
  ): Promise<T> {
    const connection = await this.createConnection();
    const { ws } = connection;
    const pending = new Map<JsonRpcId, PendingRequest>();
    let requestId = 0;

    const rejectPending = (error: unknown): void => {
      const normalized = normalizeError(error);
      for (const pendingRequest of pending.values()) {
        pendingRequest.reject(normalized);
      }
      pending.clear();
    };

    const send = (message: JsonRpcRequest | JsonRpcNotification): void => {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("Codex app-server connection is not open");
      }

      ws.send(JSON.stringify(message));
    };

    const request = async <TResponse>(
      method: string,
      params?: unknown
    ): Promise<TResponse> => {
      requestId += 1;
      const id = requestId;
      send({
        jsonrpc: "2.0",
        id,
        method,
        params
      });

      return new Promise<TResponse>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as TResponse),
          reject
        });
      });
    };

    ws.on("message", (rawMessage: WebSocket.RawData) => {
      let message: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;

      try {
        message = JSON.parse(rawMessage.toString());
      } catch (error) {
        rejectPending(error);
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
            new Error(response.error.message ?? "Codex app-server request failed")
          );
          return;
        }

        pendingRequest.resolve(response.result);
        return;
      }

      if ("id" in message && "method" in message) {
        this.respondToServerRequest(ws, message.id, message.method);
      }
    });

    ws.on("error", (error) => {
      rejectPending(error);
    });

    ws.on("close", () => {
      rejectPending(new Error("Codex app-server connection closed"));
    });

    try {
      await request("initialize", {
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

      return await operation(request);
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }

  private respondToServerRequest(
    socket: WebSocket,
    id: JsonRpcId,
    method: string
  ): void {
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
  }
}
