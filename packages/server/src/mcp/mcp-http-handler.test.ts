import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../services/tool-registry.js";
import { createMcpHttpHandler, MCP_NONCE_HEADER } from "./mcp-http-handler.js";
import { McpNonceRegistry } from "./nonce-registry.js";

describe("mcp-http-handler", () => {
  let server: HttpServer;
  let baseUrl: string;
  let registry: ToolRegistry;
  let nonces: McpNonceRegistry;
  let invocations: Array<{
    name: string;
    input: unknown;
    ctx: unknown;
  }>;

  beforeEach(async () => {
    invocations = [];
    registry = new ToolRegistry();
    nonces = new McpNonceRegistry();

    registry.register<{ message: string }, { echoed: string; ctx: unknown }>({
      name: "echo",
      description: "returns the input for tests",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"]
      },
      handler: async (input, ctx) => {
        invocations.push({ name: "echo", input, ctx });
        return { echoed: (input as { message: string }).message, ctx };
      }
    });

    registry.register<Record<string, unknown>, { ok: true }>({
      name: "boom",
      description: "always throws",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        throw new Error("intentional failure");
      }
    });

    server = createServer(createMcpHttpHandler(registry, nonces));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  async function connectClient(nonce: string | undefined) {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: {
        headers: nonce ? { [MCP_NONCE_HEADER]: nonce } : {}
      }
    });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(transport);
    return { client, transport };
  }

  it("rejects requests without a nonce", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {}
      })
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with an unknown nonce", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [MCP_NONCE_HEADER]: "not-a-real-nonce"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {}
      })
    });
    expect(res.status).toBe(401);
  });

  it("lists tools and dispatches calls with ctx bound to the nonce", async () => {
    const ctx = {
      workspaceId: "ws-1",
      threadId: "th-1",
      agentId: "ag-1"
    };
    const nonce = nonces.mint(ctx);

    const { client, transport } = await connectClient(nonce);
    try {
      const listed = await client.listTools();
      const toolNames = listed.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual(["boom", "echo"]);

      const result = await client.callTool({
        name: "echo",
        arguments: { message: "hello" }
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        echoed: string;
        ctx: unknown;
      };
      expect(parsed.echoed).toBe("hello");
      expect(parsed.ctx).toEqual(ctx);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({
        name: "echo",
        input: { message: "hello" },
        ctx
      });
    } finally {
      await transport.close();
      await client.close();
    }
  });

  it("surfaces handler errors as MCP isError results", async () => {
    const nonce = nonces.mint({
      workspaceId: "ws-1",
      threadId: "th-1",
      agentId: "ag-1"
    });
    const { client, transport } = await connectClient(nonce);
    try {
      const result = await client.callTool({ name: "boom", arguments: {} });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("intentional failure");
    } finally {
      await transport.close();
      await client.close();
    }
  });

  it("does not leak ctx across nonces", async () => {
    const ctxA = {
      workspaceId: "ws-A",
      threadId: "th-A",
      agentId: "ag-A"
    };
    const ctxB = {
      workspaceId: "ws-B",
      threadId: "th-B",
      agentId: "ag-B"
    };
    const nonceA = nonces.mint(ctxA);
    const nonceB = nonces.mint(ctxB);

    const sessionA = await connectClient(nonceA);
    const sessionB = await connectClient(nonceB);
    try {
      await sessionA.client.callTool({
        name: "echo",
        arguments: { message: "a" }
      });
      await sessionB.client.callTool({
        name: "echo",
        arguments: { message: "b" }
      });
      expect(invocations).toHaveLength(2);
      const [first, second] = invocations as [
        (typeof invocations)[number],
        (typeof invocations)[number]
      ];
      expect((first.input as { message: string }).message).toBe("a");
      expect(first.ctx).toEqual(ctxA);
      expect((second.input as { message: string }).message).toBe("b");
      expect(second.ctx).toEqual(ctxB);
    } finally {
      await sessionA.transport.close();
      await sessionA.client.close();
      await sessionB.transport.close();
      await sessionB.client.close();
    }
  });

  it("rejects after the nonce is revoked", async () => {
    const nonce = nonces.mint({
      workspaceId: "ws-1",
      threadId: "th-1",
      agentId: "ag-1"
    });
    nonces.revoke(nonce);

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [MCP_NONCE_HEADER]: nonce
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {}
      })
    });
    expect(res.status).toBe(401);
  });
});
