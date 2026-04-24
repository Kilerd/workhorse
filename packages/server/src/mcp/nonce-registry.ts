import { randomBytes } from "node:crypto";

import type { ToolHandlerCtx } from "../services/tool-registry.js";

/**
 * Per-run authorization for MCP tool calls coming from claude-cli subprocesses.
 *
 * The coordinator runner mints a nonce bound to a ToolHandlerCtx just before
 * it spawns `claude`, writes it into the subprocess' mcp-config as an HTTP
 * header, and revokes it when the run exits. The /mcp HTTP endpoint looks up
 * the ctx by that header — there is no other trust relationship between the
 * MCP server and the subprocess.
 */
export interface McpNonceEntry {
  ctx: ToolHandlerCtx;
  expiresAt: number;
}

export class McpNonceRegistry {
  private readonly entries = new Map<string, McpNonceEntry>();
  private readonly ttlMs: number;

  public constructor(ttlMs = 60 * 60 * 1_000) {
    this.ttlMs = ttlMs;
  }

  public mint(ctx: ToolHandlerCtx): string {
    const nonce = randomBytes(24).toString("hex");
    this.entries.set(nonce, { ctx, expiresAt: Date.now() + this.ttlMs });
    return nonce;
  }

  public verify(nonce: string): ToolHandlerCtx | undefined {
    const entry = this.entries.get(nonce);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(nonce);
      return undefined;
    }
    return entry.ctx;
  }

  public revoke(nonce: string): void {
    this.entries.delete(nonce);
  }
}
