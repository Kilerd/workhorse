import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ShellRunnerConfig } from "@workhorse/contracts";

import { AppError } from "../lib/errors.js";
import type { RunnerAdapter, RunnerControl, RunnerLifecycleHooks, RunnerStartContext } from "./types.js";

interface ActiveShellControl extends RunnerControl {
  child: ChildProcessWithoutNullStreams;
}

export class ShellRunner implements RunnerAdapter {
  public readonly type = "shell" as const;

  public async start(
    context: RunnerStartContext,
    hooks: RunnerLifecycleHooks
  ): Promise<RunnerControl> {
    const config = context.task.runnerConfig;
    if (config.type !== "shell") {
      throw new AppError(400, "INVALID_RUNNER_CONFIG", "Task is not configured for shell execution");
    }

    const shellConfig = config as ShellRunnerConfig;
    const child = spawn(shellConfig.command, {
      cwd: context.workspace.rootPath,
      shell: true,
      env: process.env
    });
    let settled = false;

    const finalize = async (status: "succeeded" | "failed" | "canceled", exitCode?: number) => {
      if (settled) {
        return;
      }
      settled = true;
      await hooks.onExit({ status, exitCode });
    };

    child.stdout.on("data", async (chunk: Buffer) => {
      await hooks.onOutput({
        kind: "text",
        text: chunk.toString("utf8"),
        stream: "stdout"
      });
    });

    child.stderr.on("data", async (chunk: Buffer) => {
      await hooks.onOutput({
        kind: "text",
        text: chunk.toString("utf8"),
        stream: "stderr"
      });
    });

    child.on("error", async (error) => {
      await hooks.onOutput({
        kind: "system",
        text: `${error.message}\n`,
        stream: "system",
        title: "Shell runner error"
      });
      await finalize("failed");
    });

    child.on("exit", async (code, signal) => {
      await finalize(
        signal ? "canceled" : code === 0 ? "succeeded" : "failed",
        code ?? undefined
      );
    });

    const control: ActiveShellControl = {
      pid: child.pid ?? undefined,
      command: shellConfig.command,
      child,
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
}
