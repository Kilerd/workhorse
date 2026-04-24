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
  validateApproveTaskParams,
  validateRejectTaskBody,
  validateRejectTaskParams,
  validateRequestTaskReviewParams,
  validateRetryTaskParams,
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
  validateWorkspaceGitPullParams,
  validateAgentParams,
  validateCreateAgentBody,
  validateUpdateAgentBody,
  validateListWorkspaceAgentsParams,
  validateMountAgentBody,
  validateWorkspaceAgentParams,
  validateUpdateAgentRoleBody,
  validateUpdateWorkspaceConfigParams,
  validateUpdateWorkspaceConfigBody,
  validateListThreadsParams,
  validateCreateThreadBody,
  validateListThreadMessagesParams,
  validateListThreadMessagesQuery,
  validatePostThreadMessageParams,
  validatePostThreadMessageBody,
  validatePlanParams
} from "@workhorse/contracts";
import type { RejectTaskBody } from "@workhorse/contracts";

import { getGitReviewMonitorIntervalMs } from "./config.js";
import { AppError } from "./lib/errors.js";
import { errorStatus, ok, toApiError, validateOrThrow } from "./lib/http.js";
import type { BoardService } from "./services/board-service.js";
import type { Orchestrator } from "./services/orchestrator.js";
import type { PlanService } from "./services/plan-service.js";
import type { ThreadService } from "./services/thread-service.js";

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
  threads?: ThreadService;
  plans?: PlanService;
  orchestrator?: Pick<Orchestrator, "restartCoordinatorThread"> &
    Partial<Pick<Orchestrator, "onThreadMessage">>;
}

export function createApp(
  service: BoardService,
  options: CreateAppOptions = {}
): Hono {
  const threads = options.threads;
  const plans = options.plans;
  const orchestrator = options.orchestrator;
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

  app.post("/api/tasks/:taskId/approve", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateApproveTaskParams,
      "Invalid task params"
    );
    const task = await service.approveTask(params.taskId);
    return c.json(ok({ task }));
  });

  app.post("/api/tasks/:taskId/reject", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateRejectTaskParams,
      "Invalid task params"
    );
    const body: RejectTaskBody = validateOrThrow(
      await readOptionalJsonBody(c.req, "Invalid reject task body"),
      validateRejectTaskBody,
      "Invalid reject task body"
    );
    const task = await service.rejectTask(params.taskId, body.reason);
    return c.json(ok({ task }));
  });

  app.post("/api/tasks/:taskId/retry", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateRetryTaskParams,
      "Invalid task params"
    );
    const task = await service.retryTask(params.taskId);
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

  // Agent CRUD routes (Phase 4)
  app.get("/api/agents", (c) => {
    const items = service.listAgents();
    return c.json(ok({ items }));
  });

  app.post("/api/agents", async (c) => {
    const body = validateOrThrow(
      await c.req.json(),
      validateCreateAgentBody,
      "Invalid create agent body"
    );
    const agent = service.createAgent(body);
    return c.json(ok({ agent }), 201);
  });

  app.get("/api/agents/:agentId", (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateAgentParams,
      "Invalid agent params"
    );
    const agent = service.getAgent(params.agentId);
    return c.json(ok({ agent }));
  });

  app.patch("/api/agents/:agentId", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateAgentParams,
      "Invalid agent params"
    );
    const body = validateOrThrow(
      await c.req.json(),
      validateUpdateAgentBody,
      "Invalid update agent body"
    );
    const agent = await service.updateAgent(params.agentId, body);
    return c.json(ok({ agent }));
  });

  app.delete("/api/agents/:agentId", (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateAgentParams,
      "Invalid agent params"
    );
    service.deleteAgent(params.agentId);
    return c.json(ok({ deleted: true }));
  });

  // Workspace Agent management routes (Phase 4)
  app.get("/api/workspaces/:workspaceId/agents", (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateListWorkspaceAgentsParams,
      "Invalid workspace params"
    );
    const items = service.listWorkspaceAgentsByWorkspace(params.workspaceId);
    return c.json(ok({ items }));
  });

  app.post("/api/workspaces/:workspaceId/agents", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateListWorkspaceAgentsParams,
      "Invalid workspace params"
    );
    const body = validateOrThrow(
      await c.req.json(),
      validateMountAgentBody,
      "Invalid mount agent body"
    );
    const agent = service.mountAgent(params.workspaceId, body);
    return c.json(ok({ agent }), 201);
  });

  app.patch("/api/workspaces/:workspaceId/agents/:agentId", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateWorkspaceAgentParams,
      "Invalid workspace agent params"
    );
    const body = validateOrThrow(
      await c.req.json(),
      validateUpdateAgentRoleBody,
      "Invalid update agent role body"
    );
    const agent = service.updateAgentRole(params.workspaceId, params.agentId, body);
    return c.json(ok({ agent }));
  });

  app.delete("/api/workspaces/:workspaceId/agents/:agentId", (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateWorkspaceAgentParams,
      "Invalid workspace agent params"
    );
    service.unmountAgent(params.workspaceId, params.agentId);
    return c.json(ok({ deleted: true }));
  });

  // Workspace config route (Phase 4)
  app.patch("/api/workspaces/:workspaceId/config", async (c) => {
    const params = validateOrThrow(
      c.req.param(),
      validateUpdateWorkspaceConfigParams,
      "Invalid workspace params"
    );
    const body = validateOrThrow(
      await c.req.json(),
      validateUpdateWorkspaceConfigBody,
      "Invalid workspace config body"
    );
    const workspace = service.updateWorkspaceConfig(params.workspaceId, body);
    return c.json(ok({ workspace }));
  });

  // ── Agent-driven board: Thread / Message routes (Spec 04) ─────────────────
  if (threads) {
    app.get("/api/workspaces/:workspaceId/threads", (c) => {
      const params = validateOrThrow(
        c.req.param(),
        validateListThreadsParams,
        "Invalid list threads params"
      );
      const items = threads.listThreads(params.workspaceId);
      return c.json(ok({ items }));
    });

    app.post("/api/workspaces/:workspaceId/threads", async (c) => {
      const params = validateOrThrow(
        c.req.param(),
        validateListThreadsParams,
        "Invalid create thread params"
      );
      const body = validateOrThrow(
        await c.req.json(),
        validateCreateThreadBody,
        "Invalid create thread body"
      );
      const thread = threads.createThread({
        workspaceId: params.workspaceId,
        kind: body.kind,
        taskId: body.taskId,
        coordinatorAgentId: body.coordinatorAgentId
      });
      return c.json(ok({ thread }), 201);
    });

    app.get("/api/threads/:threadId/messages", (c) => {
      const params = validateOrThrow(
        c.req.param(),
        validateListThreadMessagesParams,
        "Invalid list thread messages params"
      );
      const query = validateOrThrow(
        queryObject(c.req.url),
        validateListThreadMessagesQuery,
        "Invalid list thread messages query"
      );
      const items = threads.listMessages(params.threadId, {
        after: query.after,
        limit: query.limit
      });
      return c.json(ok({ items }));
    });

    app.post("/api/threads/:threadId/messages", async (c) => {
      const params = validateOrThrow(
        c.req.param(),
        validatePostThreadMessageParams,
        "Invalid post thread message params"
      );
      const body = validateOrThrow(
        await c.req.json(),
        validatePostThreadMessageBody,
        "Invalid post thread message body"
      );
      const message = threads.appendMessage({
        threadId: params.threadId,
        sender: { type: "user" },
        kind: body.kind ?? "chat",
        payload: { text: body.content }
      });
      const thread = threads.requireThread(params.threadId);
      if (thread.kind === "coordinator" && orchestrator?.onThreadMessage) {
        void orchestrator.onThreadMessage(params.threadId).catch((error) => {
          console.error(
            `[thread-api] failed to trigger coordinator thread ${params.threadId}`,
            error
          );
        });
      }
      return c.json(ok({ message }), 201);
    });

    app.post("/api/threads/:threadId/restart", async (c) => {
      const params = validateOrThrow(
        c.req.param(),
        validatePostThreadMessageParams,
        "Invalid restart thread params"
      );
      if (!orchestrator) {
        throw new AppError(
          503,
          "ORCHESTRATOR_UNAVAILABLE",
          "Coordinator orchestrator is not available"
        );
      }
      const thread = threads.requireThread(params.threadId);
      if (thread.kind !== "coordinator") {
        throw new AppError(
          409,
          "THREAD_NOT_COORDINATOR",
          `Thread ${params.threadId} is not a coordinator thread`
        );
      }
      const coordinator = service
        .listWorkspaceAgentsByWorkspace(thread.workspaceId)
        .find((agent) => agent.role === "coordinator");
      if (!coordinator) {
        throw new AppError(
          409,
          "COORDINATOR_AGENT_NOT_MOUNTED",
          `Workspace ${thread.workspaceId} has no mounted coordinator agent`
        );
      }
      const restarted = await orchestrator.restartCoordinatorThread(
        params.threadId,
        coordinator.id
      );
      return c.json(ok({ thread: restarted }));
    });
  }

  // ── Agent-driven board: Plan routes (Spec 05) ────────────────────────────
  if (plans) {
    app.get("/api/plans/:planId", (c) => {
      const params = validateOrThrow(
        c.req.param(),
        validatePlanParams,
        "Invalid plan params"
      );
      const plan = plans.requirePlan(params.planId);
      return c.json(ok({ plan }));
    });

    app.post("/api/plans/:planId/approve", async (c) => {
      const params = validateOrThrow(
        c.req.param(),
        validatePlanParams,
        "Invalid plan params"
      );
      // Approve body is currently unused; reserved for future approver metadata.
      await readOptionalJsonBody(c.req, "Invalid approve body");
      const { plan } = plans.approve(params.planId);
      return c.json(ok({ plan }));
    });

    app.post("/api/plans/:planId/reject", async (c) => {
      const params = validateOrThrow(
        c.req.param(),
        validatePlanParams,
        "Invalid plan params"
      );
      const raw = (await readOptionalJsonBody(c.req, "Invalid reject body")) as
        | { reason?: string }
        | undefined;
      const reason =
        raw && typeof raw === "object" && typeof raw.reason === "string"
          ? raw.reason
          : undefined;
      const plan = plans.reject(params.planId, {}, reason);
      return c.json(ok({ plan }));
    });
  }

  return app;
}
