import { Hono } from "hono";

import {
  buildOpenApiDocument,
  validateCleanupTaskWorktreeParams,
  validateCreateTaskBody,
  validateCreateWorkspaceBody,
  validateDeleteTaskParams,
  validateDeleteWorkspaceParams,
  validateGetTaskDependenciesParams,
  validateListWorkspaceGitRefsParams,
  validateListRunsParams,
  validateListTasksQuery,
  validatePlanFeedbackBody,
  validatePlanFeedbackParams,
  validatePlanTaskParams,
  validateRequestTaskReviewParams,
  validateSetTaskDependenciesBody,
  validateSetTaskDependenciesParams,
  validateTaskDiffParams,
  validateRunLogParams,
  validateStartTaskBody,
  validateStartTaskParams,
  validateStopTaskParams,
  validateTaskInputBody,
  validateTaskInputParams,
  validateUpdateSettingsBody,
  validateUpdateTaskBody,
  validateUpdateTaskParams,
  validateUpdateWorkspaceBody,
  validateUpdateWorkspaceParams,
  validateWorkspaceGitStatusParams,
  validateWorkspaceGitPullParams
} from "@workhorse/contracts";

import { getGitReviewMonitorIntervalMs } from "./config.js";
import { AppError } from "./lib/errors.js";
import { errorStatus, ok, toApiError, validateOrThrow } from "./lib/http.js";
import type { BoardService } from "./services/board-service.js";

function queryObject(url: string): Record<string, string> {
  const search = new URL(url).searchParams;
  return Object.fromEntries(search.entries());
}

async function readOptionalJsonBody(
  request: { text(): Promise<string> },
  message: string
): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", message);
  }
}

interface CreateAppOptions {
  reviewMonitorIntervalMs?: number;
}

export function createApp(
  service: BoardService,
  options: CreateAppOptions = {}
): Hono {
  const app = new Hono();
  const openApiDocument = buildOpenApiDocument();
  const reviewMonitorIntervalMs =
    options.reviewMonitorIntervalMs ?? getGitReviewMonitorIntervalMs();

  app.onError((error) =>
    new Response(JSON.stringify(toApiError(error)), {
      status: errorStatus(error),
      headers: {
        "content-type": "application/json"
      }
    })
  );

  app.get("/openapi.json", (c) => c.json(openApiDocument));

  app.get("/api/health", async (c) =>
    c.json(
      ok({
        status: "ok",
        state: { schemaVersion: service.snapshot().schemaVersion },
        reviewMonitor: {
          intervalMs: reviewMonitorIntervalMs,
          lastPolledAt: service.getReviewMonitorLastPolledAt()
        },
        codexQuota: await service.getCodexQuota()
      })
    )
  );

  app.get("/api/settings", (c) =>
    c.json(ok({ settings: service.getSettings() }))
  );

  app.patch("/api/settings", async (c) => {
    const body = validateOrThrow(
      await c.req.json(),
      validateUpdateSettingsBody,
      "Invalid settings payload"
    );
    const settings = await service.updateSettings(body);
    return c.json(ok({ settings }));
  });

  app.get("/api/workspaces", (c) =>
    c.json(ok({ items: service.listWorkspaces() }))
  );

  app.post("/api/workspaces/pick-root", async (c) =>
    c.json(
      ok({
        rootPath: await service.pickWorkspaceRootPath()
      })
    )
  );

  app.post("/api/workspaces", async (c) => {
    const body = validateOrThrow(
      await c.req.json(),
      validateCreateWorkspaceBody,
      "Invalid workspace payload"
    );
    const workspace = await service.createWorkspace(body);
    return c.json(ok({ workspace }), 201);
  });

  app.patch("/api/workspaces/:workspaceId", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateUpdateWorkspaceParams,
      "Invalid workspace params"
    );
    const body = validateOrThrow(
      await c.req.json(),
      validateUpdateWorkspaceBody,
      "Invalid workspace payload"
    );
    const workspace = await service.updateWorkspace(params.workspaceId, body);
    return c.json(ok({ workspace }));
  });

  app.get("/api/workspaces/:workspaceId/git/refs", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateListWorkspaceGitRefsParams,
      "Invalid workspace params"
    );
    const items = await service.listWorkspaceGitRefs(params.workspaceId);
    return c.json(ok({ items }));
  });

  app.get("/api/workspaces/:workspaceId/git/status", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateWorkspaceGitStatusParams,
      "Invalid workspace params"
    );
    const status = await service.getWorkspaceGitStatus(params.workspaceId);
    return c.json(ok(status));
  });

  app.post("/api/workspaces/:workspaceId/git/pull", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateWorkspaceGitPullParams,
      "Invalid workspace params"
    );
    const result = await service.pullWorkspace(params.workspaceId);
    return c.json(ok(result));
  });

  app.delete("/api/workspaces/:workspaceId", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateDeleteWorkspaceParams,
      "Invalid workspace params"
    );
    const result = await service.deleteWorkspace(params.workspaceId);
    return c.json(ok(result));
  });

  app.get("/api/tasks", (c) => {
    const query = validateOrThrow(
      queryObject(c.req.url),
      validateListTasksQuery,
      "Invalid task query"
    );
    return c.json(ok({ items: service.listTasks(query) }));
  });

  app.post("/api/tasks", async (c) => {
    const body = validateOrThrow(
      await c.req.json(),
      validateCreateTaskBody,
      "Invalid task payload"
    );
    const task = await service.createTask(body);
    return c.json(ok({ task }), 201);
  });

  app.patch("/api/tasks/:taskId", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateUpdateTaskParams,
      "Invalid task params"
    );
    const body = validateOrThrow(
      await c.req.json(),
      validateUpdateTaskBody,
      "Invalid task payload"
    );
    const task = await service.updateTask(params.taskId, body);
    return c.json(ok({ task }));
  });

  app.delete("/api/tasks/:taskId", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateDeleteTaskParams,
      "Invalid task params"
    );
    const result = await service.deleteTask(params.taskId);
    return c.json(ok(result));
  });

  app.post("/api/tasks/:taskId/start", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateStartTaskParams,
      "Invalid task params"
    );
    const body = validateOrThrow(
      await readOptionalJsonBody(c.req, "Invalid start task payload"),
      validateStartTaskBody,
      "Invalid start task payload"
    );
    const result = await service.startTask(params.taskId, body);
    return c.json(ok(result));
  });

  app.post("/api/tasks/:taskId/stop", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateStopTaskParams,
      "Invalid task params"
    );
    const result = await service.stopTask(params.taskId);
    return c.json(ok(result));
  });

  app.post("/api/tasks/:taskId/input", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateTaskInputParams,
      "Invalid task params"
    );
    const body = validateOrThrow(
      await c.req.json(),
      validateTaskInputBody,
      "Invalid task input"
    );
    const result = await service.sendTaskInput(params.taskId, body);
    return c.json(ok(result));
  });

  app.post("/api/tasks/:taskId/plan", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validatePlanTaskParams,
      "Invalid task params"
    );
    const result = await service.planTask(params.taskId);
    return c.json(ok(result));
  });

  app.post("/api/tasks/:taskId/plan-feedback", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validatePlanFeedbackParams,
      "Invalid task params"
    );
    const body = validateOrThrow(
      await c.req.json(),
      validatePlanFeedbackBody,
      "Invalid plan feedback body"
    );
    const result = await service.sendPlanFeedback(params.taskId, body);
    return c.json(ok(result));
  });

  app.post("/api/tasks/:taskId/review-request", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateRequestTaskReviewParams,
      "Invalid task params"
    );
    const result = await service.requestTaskReview(params.taskId);
    return c.json(ok(result));
  });

  app.get("/api/tasks/:taskId/diff", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateTaskDiffParams,
      "Invalid task params"
    );
    const result = await service.getTaskDiff(params.taskId);
    return c.json(ok(result));
  });

  app.post("/api/tasks/:taskId/worktree/cleanup", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateCleanupTaskWorktreeParams,
      "Invalid task params"
    );
    const task = await service.cleanupTaskWorktree(params.taskId);
    return c.json(ok({ task }));
  });

  app.get("/api/tasks/:taskId/runs", (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateListRunsParams,
      "Invalid run params"
    );
    return c.json(ok({ items: service.listRuns(params.taskId) }));
  });

  app.get("/api/runs/:runId/log", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateRunLogParams,
      "Invalid run params"
    );
    const items = await service.getRunLog(params.runId);
    return c.json(ok({ items }));
  });

  app.put("/api/tasks/:taskId/dependencies", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateSetTaskDependenciesParams,
      "Invalid task params"
    );
    const body = validateOrThrow(
      await c.req.json(),
      validateSetTaskDependenciesBody,
      "Invalid dependencies payload"
    );
    const task = await service.setTaskDependencies(params.taskId, body.dependencies);
    return c.json(ok({ task }));
  });

  app.get("/api/tasks/:taskId/dependencies", (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateGetTaskDependenciesParams,
      "Invalid task params"
    );
    const task = service.getTask(params.taskId);
    return c.json(ok({ task }));
  });

  app.get("/api/scheduler/status", (c) => {
    return c.json(ok(service.getSchedulerStatus()));
  });

  app.post("/api/scheduler/evaluate", async (c) => {
    return c.json(ok(await service.evaluateScheduler()));
  });

  return app;
}
