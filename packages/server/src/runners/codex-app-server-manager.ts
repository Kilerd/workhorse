import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import WebSocket from "ws";

import { AppError } from "../lib/errors.js";
import { getAvailablePort } from "../lib/net.js";

function isChildAlive(child: ChildProcessWithoutNullStreams | undefined): boolean {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

export interface CodexAppServerConnection {
  ws: WebSocket;
  pid?: number;
  command: string;
}

export class CodexAppServerManager {
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
}
