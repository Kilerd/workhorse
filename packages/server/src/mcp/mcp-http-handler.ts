import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolRegistry } from "../services/tool-registry.js";
import type { McpNonceRegistry } from "./nonce-registry.js";

export const MCP_NONCE_HEADER = "x-workhorse-nonce";

/**
 * Wires the ToolRegistry into an MCP Streamable-HTTP endpoint. One Server +
 * Transport pair is built per request (stateless mode), so nonces and ctxs
 * do not leak across runs.
 *
 * Claude CLI subprocesses reach this endpoint when the coordinator runner
 * feeds them `--mcp-config` pointing at /mcp with the nonce header.
 */
export function createMcpHttpHandler(
  registry: ToolRegistry,
  nonces: McpNonceRegistry
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const nonceHeader = req.headers[MCP_NONCE_HEADER];
    const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
    const ctx = nonce ? nonces.verify(nonce) : undefined;
    if (!ctx) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "invalid or missing nonce" }));
      return;
    }

    const server = new Server(
      { name: "workhorse", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as {
          type: "object";
          properties?: Record<string, unknown>;
        }
      }))
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: input } = request.params;
      try {
        const result = await registry.invoke(name, input ?? {}, ctx);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: message }]
        };
      }
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    try {
      await server.connect(transport);
      const parsedBody = await parseJsonBody(req);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      console.error("[mcp] request failed", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "mcp handler error" }));
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "DELETE") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
