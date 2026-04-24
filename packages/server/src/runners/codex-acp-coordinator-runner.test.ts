import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import type { CodexAppServer } from "./codex-app-server-manager.js";
import { CodexAcpCoordinatorRunner } from "./codex-acp-coordinator-runner.js";
import type { CoordinatorOutputChunk, CoordinatorRunInput } from "./session-bridge.js";

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

function makeInput(
  overrides: Partial<Pick<CoordinatorRunInput, "tools">> = {}
): CoordinatorRunInput {
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
    tools: overrides.tools ?? []
  };
}

describe("CodexAcpCoordinatorRunner", () => {
  let server: WebSocketServer | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("exposes Workhorse tools through Codex ACP dynamic tools and resolves calls", async () => {
    let threadStartParams: Record<string, any> | undefined;
    let completeTurn: (() => void) | undefined;
    let requestToolCall: (() => void) | undefined;
    let resolveToolResponse: (message: Record<string, any>) => void = () => {};
    const toolResponse = new Promise<Record<string, any>>((resolve) => {
      resolveToolResponse = resolve;
    });

    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as {
          id?: number | string;
          method?: string;
          params?: unknown;
          result?: unknown;
        };
        if (message.id === "tool-request-1" && "result" in message) {
          resolveToolResponse(message as Record<string, any>);
          return;
        }
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
          requestToolCall = () => {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "tool-request-1",
                method: "item/tool/call",
                params: {
                  threadId: "acp-thread-1",
                  turnId: "turn-1",
                  callId: "call-1",
                  tool: "get_workspace_state",
                  arguments: { includeArchived: false }
                }
              })
            );
          };
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

    const runner = new CodexAcpCoordinatorRunner({
      appServer: new FakeCodexAppServer(`ws://127.0.0.1:${address.port}`)
    });

    const handle = await runner.resumeOrStart(
      makeInput({
        tools: [
          {
            name: "get_workspace_state",
            description: "Read the current workspace state.",
            inputSchema: {
              type: "object",
              properties: {
                includeArchived: { type: "boolean" }
              }
            }
          }
        ]
      })
    );
    const finish = new Promise((resolve) => handle.onFinish(resolve));
    const toolUse = new Promise<CoordinatorOutputChunk>((resolve) => {
      handle.onChunk((chunk) => {
        if (chunk.type === "tool_use") {
          resolve(chunk);
        }
      });
    });

    expect(threadStartParams?.dynamicTools).toEqual([
      {
        name: "get_workspace_state",
        description: "Read the current workspace state.",
        inputSchema: {
          type: "object",
          properties: {
            includeArchived: { type: "boolean" }
          }
        }
      }
    ]);
    expect(threadStartParams?.mcpServers).toBeUndefined();

    requestToolCall?.();
    await expect(toolUse).resolves.toMatchObject({
      type: "tool_use",
      toolUseId: "call-1",
      name: "get_workspace_state",
      input: { includeArchived: false }
    });

    await handle.submitToolResult({
      toolUseId: "call-1",
      result: { ok: true, workspaceId: "workspace-1" }
    });
    await expect(toolResponse).resolves.toMatchObject({
      result: {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({ ok: true, workspaceId: "workspace-1" }, null, 2)
          }
        ]
      }
    });

    completeTurn?.();
    await finish;
  });
});
