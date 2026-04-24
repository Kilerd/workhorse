import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import type { CodexAppServer } from "./codex-app-server-manager.js";
import { CodexAcpCoordinatorRunner } from "./codex-acp-coordinator-runner.js";
import { McpNonceRegistry } from "../mcp/nonce-registry.js";
import type { CoordinatorRunInput } from "./session-bridge.js";

class FakeCodexAppServer implements CodexAppServer {
  public constructor(private readonly url: string) {}

  public async initialize(): Promise<void> {}

  public async createConnection() {
    const ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return { ws, command: "fake-codex-app-server" };
  }

  public async readAccountRateLimits(): Promise<null> {
    return null;
  }

  public async archiveThread(): Promise<void> {}
}

function makeInput(): CoordinatorRunInput {
  const now = new Date().toISOString();
  return {
    runId: "run-1",
    threadId: "thread-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    runnerConfig: {
      type: "codex",
      prompt: "",
      model: { mode: "builtin", id: "gpt-5.4" }
    },
    workspace: {
      id: "workspace-1",
      name: "Workhorse",
      rootPath: "/tmp/workhorse",
      isGitRepo: true,
      codexSettings: {
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write"
      },
      createdAt: now,
      updatedAt: now
    },
    workspaceDir: "/tmp/workhorse",
    systemPrompt: "system",
    appendMessages: [{ role: "user", content: "hello" }],
    tools: []
  };
}

describe("CodexAcpCoordinatorRunner", () => {
  let server: WebSocketServer | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("passes the Workhorse MCP server to Codex ACP sessions with a run-bound nonce", async () => {
    let threadStartParams: Record<string, any> | undefined;
    let completeTurn: (() => void) | undefined;

    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as {
          id?: number;
          method?: string;
          params?: unknown;
        };
        if (!message.id) {
          return;
        }
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { userAgent: "fake" }
            })
          );
          return;
        }
        if (message.method === "thread/start") {
          threadStartParams = message.params as Record<string, any>;
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { thread: { id: "acp-thread-1" } }
            })
          );
          return;
        }
        if (message.method === "turn/start") {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { turn: { id: "turn-1" } }
            })
          );
          completeTurn = () => {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "turn/completed",
                params: {
                  threadId: "acp-thread-1",
                  turn: { id: "turn-1", status: "completed", error: null }
                }
              })
            );
          };
        }
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected test websocket server to bind a TCP port");
    }

    const nonces = new McpNonceRegistry();
    const runner = new CodexAcpCoordinatorRunner({
      appServer: new FakeCodexAppServer(`ws://127.0.0.1:${address.port}`),
      mcpNonces: nonces,
      mcpUrl: "http://127.0.0.1:3999/mcp"
    });

    const handle = await runner.resumeOrStart(makeInput());
    const finish = new Promise((resolve) => handle.onFinish(resolve));

    expect(threadStartParams?.mcpServers).toHaveLength(1);
    const mcpServer = threadStartParams?.mcpServers[0];
    expect(mcpServer).toMatchObject({
      name: "workhorse",
      type: "http",
      url: "http://127.0.0.1:3999/mcp"
    });
    expect(mcpServer.headers).toEqual([
      expect.objectContaining({ name: "x-workhorse-nonce" })
    ]);
    const nonce = mcpServer.headers[0].value as string;
    expect(nonces.verify(nonce)).toMatchObject({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      agentId: "agent-1"
    });

    completeTurn?.();
    await finish;
    expect(nonces.verify(nonce)).toBeUndefined();
  });
});
