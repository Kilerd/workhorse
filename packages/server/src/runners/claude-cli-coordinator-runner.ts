import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunStatus } from "@workhorse/contracts";

import { MCP_NONCE_HEADER } from "../mcp/mcp-http-handler.js";
import type { McpNonceRegistry } from "../mcp/nonce-registry.js";
import type {
  CoordinatorInputMessage,
  CoordinatorOutputChunk,
  CoordinatorRunHandle,
  CoordinatorRunInput,
  CoordinatorRunOutcome,
  CoordinatorRunner
} from "./session-bridge.js";

export interface ClaudeCliCoordinatorRunnerOptions {
  /** Override the binary to spawn. Useful in dev where `claude` may be aliased. */
  command?: string;
  /** Extra args appended after the managed ones. */
  extraArgs?: string[];
  /**
   * When provided, the runner mints a per-run nonce, writes an mcp-config
   * pointing `claude` at the in-process MCP HTTP endpoint, and revokes the
   * nonce on exit. Without these, claude runs in chat-only mode.
   */
  mcpNonces?: McpNonceRegistry;
  mcpUrl?: string;
  /** Name the MCP server shows up as to claude; default "workhorse". */
  mcpServerName?: string;
}

/**
 * Chat-only CoordinatorRunner backed by `claude -p --output-format stream-json`.
 *
 * What this adapter does:
 *   - Spawns Claude CLI once per coordinator turn.
 *   - Passes the system prompt + concatenated append messages on stdin.
 *   - Resumes the session if `sessionKey` is supplied (`--resume <id>`).
 *   - Emits `text` chunks for assistant output and a `session_key` chunk
 *     when the CLI reports its session id (first `init`/`result` event).
 *   - Exits successfully on process exit with code 0, or failed otherwise.
 *
 * What it does NOT do yet (tracked for Spec 07e-2 follow-up):
 *   - Tool invocation. Claude CLI expects tools to be exposed via MCP; we
 *     have not wired an MCP bridge for our `ToolRegistry`. Tool-use content
 *     blocks in assistant messages are logged to stderr and surfaced as
 *     text so the run still completes.
 *   - Parallel runs on the same session (callers serialize via Orchestrator).
 */
export class ClaudeCliCoordinatorRunner implements CoordinatorRunner {
  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly mcpNonces?: McpNonceRegistry;
  private readonly mcpUrl?: string;
  private readonly mcpServerName: string;

  public constructor(options: ClaudeCliCoordinatorRunnerOptions = {}) {
    this.command = options.command ?? "claude";
    this.extraArgs = options.extraArgs ?? [];
    this.mcpNonces = options.mcpNonces;
    this.mcpUrl = options.mcpUrl;
    this.mcpServerName = options.mcpServerName ?? "workhorse";
  }

  public async resumeOrStart(
    input: CoordinatorRunInput
  ): Promise<CoordinatorRunHandle> {
    const mcpBinding = this.prepareMcpConfig(input);

    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      ...(mcpBinding
        ? [
            "--mcp-config",
            mcpBinding.configPath,
            "--strict-mcp-config",
            "--dangerously-skip-permissions"
          ]
        : ["--permission-mode", "default"]),
      ...(input.sessionKey ? ["--resume", input.sessionKey] : []),
      ...this.extraArgs
    ];

    console.log(
      `[claude-coord] spawn thread=${input.threadId} resume=${input.sessionKey ?? "(new)"} msgs=${input.appendMessages.length} tools=${input.tools.length} mcp=${mcpBinding ? "on" : "off"}`
    );

    const child = spawn(this.command, args, {
      cwd: input.workspaceDir,
      env: process.env
    });

    const chunkHandlers = new Set<(chunk: CoordinatorOutputChunk) => void>();
    const finishHandlers = new Set<(outcome: CoordinatorRunOutcome) => void>();
    let settled = false;
    let seenSessionKeys = new Set<string>();
    let stdoutBuffer = "";
    let textEmitted = false;

    const emitChunk = (chunk: CoordinatorOutputChunk) => {
      if (chunk.type === "text") textEmitted = true;
      for (const h of chunkHandlers) {
        try {
          h(chunk);
        } catch (error) {
          console.warn("[claude-coord] chunk handler threw", error);
        }
      }
    };

    const finish = (outcome: CoordinatorRunOutcome) => {
      if (settled) return;
      settled = true;
      for (const h of finishHandlers) {
        try {
          h(outcome);
        } catch (error) {
          console.warn("[claude-coord] finish handler threw", error);
        }
      }
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Unknown lines: surface as text so nothing is silently dropped.
        emitChunk({ type: "text", text: line });
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const event = parsed as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "";

      const sessionId =
        typeof event.session_id === "string" ? event.session_id : undefined;
      if (sessionId && !seenSessionKeys.has(sessionId)) {
        seenSessionKeys.add(sessionId);
        emitChunk({ type: "session_key", key: sessionId });
      }

      if (type === "assistant") {
        const text = extractAssistantText(event);
        if (text) emitChunk({ type: "text", text });
        return;
      }

      if (type === "result") {
        // The result event summarizes text already streamed via assistant
        // events or stderr. Only surface it when nothing else was emitted.
        if (textEmitted) return;
        const resultText =
          typeof event.result === "string" ? event.result : "";
        if (resultText) emitChunk({ type: "text", text: resultText });
      }
    };

    const drainStdout = (final: boolean) => {
      const lines = stdoutBuffer.split("\n");
      const pending = final ? lines : lines.slice(0, -1);
      stdoutBuffer = final ? "" : (lines.at(-1) ?? "");
      for (const line of pending) handleLine(line);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      drainStdout(false);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // Route stderr as text so orchestrators / UI see failures.
      const text = chunk.toString("utf8");
      if (text.trim()) emitChunk({ type: "text", text });
    });

    child.on("error", (error) => {
      emitChunk({ type: "text", text: `[claude-coord] ${error.message}` });
      finish({ status: "failed", error: error.message });
    });

    child.on("exit", (code, signal) => {
      drainStdout(true);
      const status: RunStatus = signal
        ? "canceled"
        : code === 0
          ? "succeeded"
          : "failed";
      console.log(
        `[claude-coord] exit thread=${input.threadId} status=${status} code=${code ?? "null"} signal=${signal ?? "null"}`
      );
      this.cleanupMcpBinding(mcpBinding);
      finish({
        status,
        exitCode: code ?? undefined,
        error: status === "failed" ? `claude exited with code ${code}` : undefined
      });
    });

    child.stdin.end(renderStdin(input.systemPrompt, input.appendMessages));

    const handle: CoordinatorRunHandle = {
      runId: input.runId,
      onChunk(handler) {
        chunkHandlers.add(handler);
        return () => {
          chunkHandlers.delete(handler);
        };
      },
      onFinish(handler) {
        finishHandlers.add(handler);
        return () => {
          finishHandlers.delete(handler);
        };
      },
      async submitToolResult() {
        // No tool loop wired yet. See Spec 07e-2 follow-up.
      },
      async cancel() {
        if (child.killed) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 1_000).unref();
      }
    };

    return handle;
  }

  private prepareMcpConfig(input: CoordinatorRunInput): McpBinding | undefined {
    if (!this.mcpNonces || !this.mcpUrl) return undefined;
    const nonce = this.mcpNonces.mint({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      agentId: input.agentId
    });
    const dir = mkdtempSync(join(tmpdir(), "workhorse-mcp-"));
    const configPath = join(dir, "mcp-config.json");
    const config = {
      mcpServers: {
        [this.mcpServerName]: {
          type: "http",
          url: this.mcpUrl,
          headers: { [MCP_NONCE_HEADER]: nonce }
        }
      }
    };
    writeFileSync(configPath, JSON.stringify(config), "utf8");
    return { dir, configPath, nonce };
  }

  private cleanupMcpBinding(binding?: McpBinding): void {
    if (!binding) return;
    this.mcpNonces?.revoke(binding.nonce);
    try {
      rmSync(binding.dir, { recursive: true, force: true });
    } catch (error) {
      console.warn("[claude-coord] failed to clean mcp tmp", error);
    }
  }
}

interface McpBinding {
  dir: string;
  configPath: string;
  nonce: string;
}

function renderStdin(
  systemPrompt: string,
  messages: CoordinatorInputMessage[]
): string {
  const sections = [
    systemPrompt.trim(),
    ...messages.map((m) => `[${m.role}] ${m.content}`)
  ].filter(Boolean);
  const body = sections.join("\n\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

function extractAssistantText(event: Record<string, unknown>): string {
  const message = event.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const rec = item as Record<string, unknown>;
      if (rec.type !== "text") return [];
      const text = typeof rec.text === "string" ? rec.text.trim() : "";
      return text ? [text] : [];
    })
    .join("\n\n")
    .trim();
}
