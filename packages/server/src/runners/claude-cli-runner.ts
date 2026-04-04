import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ClaudeRunnerConfig, RunStatus } from "@workhorse/contracts";

import { AppError } from "../lib/errors.js";
import { extractReviewResult, type ParsedReviewResult } from "../lib/review-parser.js";
import type {
  RunnerAdapter,
  RunnerControl,
  RunnerLifecycleHooks,
  RunnerStartContext
} from "./types.js";

interface ActiveClaudeControl extends RunnerControl {
  child: ChildProcessWithoutNullStreams;
}

interface ClaudeRunnerState {
  emittedAssistantTexts: Set<string>;
  finalStatus?: RunStatus;
  metadata: Record<string, string>;
}


function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function toMetadata(
  values: Record<string, string | undefined>
): Record<string, string> | undefined {
  const metadata = Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}


export class ClaudeCliRunner implements RunnerAdapter {
  public readonly type = "claude" as const;

  public buildCommandArgs(
    config: ClaudeRunnerConfig,
    options?: { resumeSessionId?: string }
  ): string[] {
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      config.permissionMode ?? "default"
    ];

    if (options?.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }

    if (config.agent?.trim()) {
      args.push("--agent", config.agent.trim());
    }

    if (config.model?.trim()) {
      args.push("--model", config.model.trim());
    }

    return args;
  }

  public buildPrompt(context: RunnerStartContext, config: ClaudeRunnerConfig): string {
    const description = context.task.description.trim();
    const inputText = context.inputText?.trim();
    const plan = context.task.plan?.trim();

    return [
      `Task: ${context.task.title}`,
      description ? `Task description:\n${description}` : undefined,
      plan ? `Implementation plan:\n${plan}` : undefined,
      `Working directory: ${context.workspace.rootPath}`,
      `Instruction:\n${config.prompt.trim()}`,
      inputText ? `Additional instruction:\n${inputText}` : undefined
    ]
      .filter((section): section is string => Boolean(section))
      .join("\n\n");
  }

  public async start(
    context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl> {
    const config = context.task.runnerConfig;
    if (config.type !== "claude") {
      throw new AppError(400, "INVALID_RUNNER_CONFIG", "Task is not configured for Claude CLI");
    }

    const claudeConfig = config as ClaudeRunnerConfig;
    const args = this.buildCommandArgs(claudeConfig, {
      resumeSessionId: context.resumeSessionId
    });
    const prompt = this.buildPrompt(context, claudeConfig);
    const child = spawn("claude", args, {
      cwd: context.workspace.rootPath,
      env: process.env
    });
    const command = this.buildCommand(args);
    const state: ClaudeRunnerState = {
      emittedAssistantTexts: new Set<string>(),
      metadata: {
        claudePermissionMode: claudeConfig.permissionMode ?? "default",
        ...(claudeConfig.agent?.trim() ? { claudeAgent: claudeConfig.agent.trim() } : {}),
        ...(claudeConfig.model?.trim() ? { claudeRequestedModel: claudeConfig.model.trim() } : {})
      }
    };
    let stdoutBuffer = "";
    let settled = false;
    let outputChain = Promise.resolve();

    const queue = (work: () => Promise<void>) => {
      const next = outputChain.then(work);
      outputChain = next.catch(() => {});
      return next;
    };

    const flushStdoutBuffer = async (force = false) => {
      const lines = stdoutBuffer.split("\n");
      const pendingLines = force ? lines : lines.slice(0, -1);
      stdoutBuffer = force ? "" : (lines.at(-1) ?? "");
      for (const line of pendingLines) {
        await this.handleStdoutLine(line, hooks, state);
      }
    };

    const finalize = async (status: RunStatus, exitCode?: number) => {
      if (settled) {
        return;
      }

      settled = true;
      await hooks.onExit({
        status,
        exitCode,
        metadata: toMetadata(state.metadata)
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      void queue(async () => {
        stdoutBuffer += chunk.toString("utf8");
        await flushStdoutBuffer(false);
      });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      void queue(async () => {
        await hooks.onOutput({
          kind: "system",
          text: chunk.toString("utf8"),
          stream: "stderr",
          title: "Claude CLI stderr",
          source: "Claude CLI"
        });
      });
    });

    child.on("error", (error) => {
      void queue(async () => {
        await hooks.onOutput({
          kind: "system",
          text: `${error.message}\n`,
          stream: "system",
          title: "Claude CLI error",
          source: "Claude CLI"
        });
        await finalize("failed");
      });
    });

    child.on("exit", (code, signal) => {
      void queue(async () => {
        await flushStdoutBuffer(true);
        await finalize(
          signal ? "canceled" : state.finalStatus ?? (code === 0 ? "succeeded" : "failed"),
          code ?? undefined
        );
      });
    });

    void queue(async () => {
      await hooks.onOutput({
        kind: "user",
        text: ensureTrailingNewline(prompt),
        stream: "system",
        title: "Prompt",
        source: "Claude CLI"
      });
    });

    child.stdin.end(ensureTrailingNewline(prompt));

    const control: ActiveClaudeControl = {
      pid: child.pid ?? undefined,
      command,
      child,
      metadata: toMetadata(state.metadata),
      async stop() {
        if (child.killed) {
          return;
        }

        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 1_000).unref();
      }
    };

    return control;
  }

  private buildCommand(args: string[]): string {
    return ["claude", ...args]
      .map((part) => (/[\s"]/u.test(part) ? JSON.stringify(part) : part))
      .join(" ");
  }

  private async handleStdoutLine(
    line: string,
    hooks: RunnerLifecycleHooks,
    state: ClaudeRunnerState
  ): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const event = JSON.parse(trimmed) as unknown;
      await this.handleParsedEvent(event, hooks, state);
    } catch {
      await hooks.onOutput({
        kind: "text",
        text: ensureTrailingNewline(line),
        stream: "stdout",
        title: "Claude CLI output",
        source: "Claude CLI"
      });
    }
  }

  private async handleParsedEvent(
    payload: unknown,
    hooks: RunnerLifecycleHooks,
    state: ClaudeRunnerState
  ): Promise<void> {
    const event = asRecord(payload);
    if (!event) {
      return;
    }

    const type = readString(event, "type");
    if (type === "system") {
      await this.handleSystemEvent(event, hooks, state);
      return;
    }

    if (type === "assistant") {
      await this.handleAssistantEvent(event, hooks, state);
      return;
    }

    if (type === "result") {
      await this.handleResultEvent(event, hooks, state);
    }
  }

  private async handleSystemEvent(
    event: Record<string, unknown>,
    hooks: RunnerLifecycleHooks,
    state: ClaudeRunnerState
  ): Promise<void> {
    if (readString(event, "subtype") !== "init") {
      return;
    }

    const sessionId = readString(event, "session_id");
    const model = readString(event, "model");
    const permissionMode = readString(event, "permissionMode");
    if (sessionId) {
      state.metadata.claudeSessionId = sessionId;
    }
    if (model) {
      state.metadata.claudeModel = model;
    }
    if (permissionMode) {
      state.metadata.claudePermissionMode = permissionMode;
    }

    const details = [
      model ? `model ${model}` : undefined,
      permissionMode ? `permission ${permissionMode}` : undefined,
      sessionId ? `session ${sessionId}` : undefined
    ]
      .filter((detail): detail is string => Boolean(detail))
      .join(" · ");

    await hooks.onOutput({
      kind: "status",
      text: ensureTrailingNewline(details || "Claude CLI session initialized"),
      stream: "system",
      title: "Claude CLI initialized",
      source: "Claude CLI",
      metadata: toMetadata({
        sessionId,
        model,
        permissionMode
      })
    });
  }

  private async handleAssistantEvent(
    event: Record<string, unknown>,
    hooks: RunnerLifecycleHooks,
    state: ClaudeRunnerState
  ): Promise<void> {
    const message = asRecord(event.message);
    const text = this.extractAssistantText(message);
    if (text) {
      const reviewResult = extractReviewResult(text);
      if (reviewResult) {
        state.metadata.reviewVerdict = reviewResult.verdict;
        state.metadata.reviewSummary = reviewResult.summary;
      }
      state.emittedAssistantTexts.add(text.trim());
      await hooks.onOutput({
        kind: "agent",
        text: ensureTrailingNewline(text),
        stream: "stdout",
        title: "Claude response",
        source: "Claude CLI",
        metadata: toMetadata({
          sessionId: readString(event, "session_id"),
          error: readString(event, "error")
        })
      });
      return;
    }

    const error = readString(event, "error");
    if (!error) {
      return;
    }

    await hooks.onOutput({
      kind: "system",
      text: ensureTrailingNewline(error),
      stream: "system",
      title: "Claude CLI error",
      source: "Claude CLI"
    });
  }

  private async handleResultEvent(
    event: Record<string, unknown>,
    hooks: RunnerLifecycleHooks,
    state: ClaudeRunnerState
  ): Promise<void> {
    const resultText = readString(event, "result");
    const sessionId = readString(event, "session_id");
    const isError = readBoolean(event, "is_error") === true;

    if (sessionId) {
      state.metadata.claudeSessionId = sessionId;
    }
    state.finalStatus = isError ? "failed" : "succeeded";

    const totalCostUsd = event.total_cost_usd;
    if (typeof totalCostUsd === "number") {
      state.metadata.claudeTotalCostUsd = String(totalCostUsd);
    }

    if (resultText) {
      const reviewResult = extractReviewResult(resultText);
      if (reviewResult) {
        state.metadata.reviewVerdict = reviewResult.verdict;
        state.metadata.reviewSummary = reviewResult.summary;
      }
    }

    if (!resultText || state.emittedAssistantTexts.has(resultText.trim())) {
      return;
    }

    await hooks.onOutput({
      kind: isError ? "system" : "agent",
      text: ensureTrailingNewline(resultText),
      stream: isError ? "system" : "stdout",
      title: isError ? "Claude CLI result" : "Claude response",
      source: "Claude CLI",
      metadata: toMetadata({
        sessionId,
        costUsd: typeof totalCostUsd === "number" ? String(totalCostUsd) : undefined
      })
    });
  }

  private extractAssistantText(message: Record<string, unknown> | null): string {
    if (!message) {
      return "";
    }

    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .flatMap((item) => {
        const contentItem = asRecord(item);
        if (!contentItem || readString(contentItem, "type") !== "text") {
          return [];
        }

        const text = readString(contentItem, "text")?.trim();
        return text ? [text] : [];
      })
      .join("\n\n")
      .trim();
  }
}
