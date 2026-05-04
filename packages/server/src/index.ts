import { createServer, type Server } from "node:http";

import { getRequestListener } from "@hono/node-server";

import { DEFAULT_PORT, DATA_DIR, getGitReviewMonitorIntervalMs } from "./config.js";
import { createApp } from "./app.js";
import { createFrontendHandler } from "./frontend.js";
import { createMcpHttpHandler } from "./mcp/mcp-http-handler.js";
import { McpNonceRegistry } from "./mcp/nonce-registry.js";
import { StateStore } from "./persistence/state-store.js";
import { CodexAcpCoordinatorRunner } from "./runners/codex-acp-coordinator-runner.js";
import { CodexAppServerManager } from "./runners/codex-app-server-manager.js";
import { ClaudeCliCoordinatorRunner } from "./runners/claude-cli-coordinator-runner.js";
import { CoordinatorRunnerRegistry } from "./runners/coordinator-runner-registry.js";
import { NoopCoordinatorRunner } from "./runners/noop-coordinator-runner.js";
import { BoardService } from "./services/board-service.js";
import { Orchestrator } from "./services/orchestrator.js";
import { PlanService } from "./services/plan-service.js";
import { TaskService } from "./services/task-service.js";
import { TaskThreadBridge } from "./services/task-thread-bridge.js";
import { ThreadService } from "./services/thread-service.js";
import { buildDefaultToolRegistry } from "./services/tool-registry.js";
import { EventBus } from "./ws/event-bus.js";

async function main(): Promise<void> {
  const store = new StateStore(DATA_DIR);
  const events = new EventBus();
  const codexAppServer = new CodexAppServerManager();
  const service = new BoardService(store, events, { codexAppServer });
  const threads = new ThreadService(store, events);
  const plans = new PlanService(store, events);
  const tasks = new TaskService(store, threads, events);
  const tools = buildDefaultToolRegistry({
    store,
    tasks,
    plans,
    threads,
    startTask: (taskId, opts) =>
      service.startTask(taskId, opts ? { useWorktree: opts.useWorktree } : {}),
    requestTaskReview: (taskId, options) => service.requestTaskReview(taskId, options)
  });
  const mcpNonces = new McpNonceRegistry();
  const mcpHandler = createMcpHttpHandler(tools, mcpNonces);
  const runners = new CoordinatorRunnerRegistry(new NoopCoordinatorRunner());
  runners.register(
    "claude",
    new ClaudeCliCoordinatorRunner({
      mcpNonces,
      mcpUrl: `http://127.0.0.1:${DEFAULT_PORT}/mcp`
    })
  );
  runners.register(
    "codex",
    new CodexAcpCoordinatorRunner({
      appServer: codexAppServer
    })
  );
  const orchestrator = new Orchestrator({
    store,
    events,
    threads,
    plans,
    tasks,
    tools,
    runners
  });
  orchestrator.start();
  const taskThreadBridge = new TaskThreadBridge({
    store,
    events,
    threads,
    sendTaskInput: (taskId, input) => service.sendTaskInput(taskId, input),
    triggerCoordinator: (threadId) => orchestrator.onThreadMessage(threadId)
  });
  taskThreadBridge.start();
  await service.initialize();
  await service.warmCodexAppServer().catch((error) => {
    console.error("Initial Codex app-server startup failed");
    console.error(error);
  });
  await service.pollGitReviewTasksForBaseUpdates().catch((error) => {
    console.error("Initial Git review monitor poll failed");
    console.error(error);
  });

  const reviewMonitorIntervalMs = getGitReviewMonitorIntervalMs();
  const app = createApp(service, {
    reviewMonitorIntervalMs,
    threads,
    plans,
    orchestrator,
    taskThreadBridge
  });
  const honoListener = getRequestListener(app.fetch);
  const server = createServer();
  const frontend = await createFrontendHandler(server);

  if (reviewMonitorIntervalMs > 0) {
    const timer = setInterval(() => {
      void service.pollGitReviewTasksForBaseUpdates().catch((error) => {
        console.error("Git review monitor poll failed");
        console.error(error);
      });
    }, reviewMonitorIntervalMs);
    timer.unref();
  }

  server.on("request", async (req, res) => {
    try {
      if (req.url && req.url.startsWith("/mcp")) {
        await mcpHandler(req, res);
        return;
      }

      const handled = await frontend.handle(req, res);
      if (handled) {
        return;
      }

      await honoListener(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "INTERNAL_ERROR",
              message: error instanceof Error ? error.message : String(error)
            }
          })
        );
      }
    }
  });

  server.listen(DEFAULT_PORT, "127.0.0.1", () => {
    console.log(`Workhorse listening on http://127.0.0.1:${DEFAULT_PORT}`);
  });

  server.on("listening", () => {
    events.attach(server as unknown as Server);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
