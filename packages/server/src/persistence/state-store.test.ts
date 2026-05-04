import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  AccountAgent,
  AppState,
  Run,
  Task,
  Workspace
} from "@workhorse/contracts";

import { StateStore } from "./state-store.js";

function makeWorkspace(): Workspace {
  const now = new Date().toISOString();
  return {
    id: "workspace-1",
    name: "Sample",
    rootPath: "/tmp/sample",
    isGitRepo: false,
    codexSettings: {
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write"
    },
    createdAt: now,
    updatedAt: now
  };
}

function makeTask(workspaceId: string): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    title: "Sample task",
    description: "",
    workspaceId,
    column: "backlog",
    order: 1_024,
    dependencies: [],
    taskKind: "user",
    worktree: {
      baseRef: "main",
      branchName: "task-1",
      status: "not_created"
    },
    createdAt: now,
    updatedAt: now
  };
}

function makeRun(taskId: string, overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    taskId,
    status: "succeeded",
    runnerType: "codex",
    command: "codex mock",
    startedAt: now,
    endedAt: now,
    logFile: `/tmp/${taskId}.log`,
    ...overrides
  };
}

describe("StateStore", () => {
  it("serializes concurrent task updates through the write lock", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    const task = makeTask(workspace.id);
    store.setWorkspaces([workspace]);
    store.setTasks([task]);
    await store.save();

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.updateTask(task.id, (current) => ({
          ...current,
          description: `${current.description}${index},`
        }))
      )
    );

    const updated = store.listTasks().find((entry) => entry.id === task.id);
    expect(updated?.description.split(",").filter(Boolean)).toHaveLength(20);
  });

  it("persists and reloads settings", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.setSettings({
      language: "English",
      openRouter: { baseUrl: "https://example.com", token: "tok", model: "gpt-4" },
      scheduler: { maxConcurrent: 5 }
    });
    await store.save();

    // Force a reload from SQLite to verify the data was actually persisted,
    // not just held in the in-memory buffer.
    (store as any).state = (store as any).readStateFromDb();

    const settings = store.getSettings();
    expect(settings.language).toBe("English");
    expect(settings.scheduler?.maxConcurrent).toBe(5);
  });

  it("persists tasks with dependencies", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    const task1 = makeTask(workspace.id);
    const task2: Task = { ...makeTask(workspace.id), id: "task-2", dependencies: ["task-1"] };
    store.setWorkspaces([workspace]);
    store.setTasks([task1, task2]);
    await store.save();

    const tasks = store.listTasks();
    const loaded2 = tasks.find((t) => t.id === "task-2");
    expect(loaded2?.dependencies).toEqual(["task-1"]);
  });

  it("prunes runs whose tasks have been removed before saving", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    const task = makeTask(workspace.id);
    const run = makeRun(task.id);
    store.setWorkspaces([workspace]);
    store.setTasks([task]);
    store.setRuns([run]);
    await store.save();

    store.setTasks([]);
    await store.save();

    expect(store.listRuns()).toEqual([]);
  });

  it("drops orphan runs and dependencies while migrating legacy JSON state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "workhorse-state-store-"));
    const workspace = makeWorkspace();
    const task = {
      ...makeTask(workspace.id),
      dependencies: ["task-missing"],
      lastRunId: "run-orphan",
      continuationRunId: "run-orphan"
    } satisfies Task;
    const legacyState = {
      schemaVersion: 6,
      settings: {
        language: "中文",
        openRouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          token: "",
          model: ""
        }
      },
      workspaces: [workspace],
      tasks: [task],
      runs: [
        makeRun(task.id, { id: "run-valid" }),
        makeRun("task-missing", { id: "run-orphan" })
      ]
    } satisfies AppState;

    await writeFile(
      join(dataDir, "state.json"),
      `${JSON.stringify(legacyState, null, 2)}\n`,
      "utf8"
    );

    const store = new StateStore(dataDir);
    await store.load();

    const snapshot = store.snapshot();
    expect(snapshot.runs.map((run) => run.id)).toEqual(["run-valid"]);
    expect(snapshot.tasks[0]?.dependencies).toEqual([]);
    expect(snapshot.tasks[0]?.lastRunId).toBeUndefined();
    expect(snapshot.tasks[0]?.continuationRunId).toBeUndefined();
  });

  it("persists cancelledAt on tasks", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    const cancelledAt = new Date().toISOString();
    const task = {
      ...makeTask(workspace.id),
      column: "done" as const,
      cancelledAt
    };
    store.setWorkspaces([workspace]);
    store.setTasks([task]);
    await store.save();

    const storeInternals = store as unknown as {
      state: unknown;
      readStateFromDb(): unknown;
    };
    storeInternals.state = storeInternals.readStateFromDb();

    expect(store.listTasks()[0]?.cancelledAt).toBe(cancelledAt);
  });

  it("appends and reads log entries", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const entry = {
      id: "entry-1",
      runId: "run-1",
      timestamp: new Date().toISOString(),
      stream: "stdout" as const,
      kind: "text" as const,
      text: "hello\n"
    };
    await store.appendLogEntry("run-1", entry);
    const entries = await store.readLogEntries("run-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("hello\n");
  });
});

// ---------------------------------------------------------------------------
// Helpers for Phase 4 agent model tests
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AccountAgent> = {}): AccountAgent {
  const now = new Date().toISOString();
  return {
    id: "agent-a",
    name: "Test Agent",
    description: "desc",
    runnerConfig: { type: "codex", prompt: "Do the assigned work." },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("StateStore — Account Agents (Phase 4)", () => {
  it("creates and retrieves an agent", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const agent = makeAgent();
    store.createAgent(agent);

    const found = store.getAgent("agent-a");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Test Agent");
    expect(found?.runnerConfig).toEqual({
      type: "codex",
      prompt: "Do the assigned work."
    });
  });

  it("lists all agents", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createAgent(makeAgent({ id: "agent-a" }));
    store.createAgent(makeAgent({ id: "agent-b", name: "Agent B" }));

    expect(store.listAgents()).toHaveLength(2);
  });

  it("updates agent fields", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createAgent(makeAgent());
    const updated = store.updateAgent("agent-a", {
      name: "Renamed",
      runnerConfig: { type: "codex", prompt: "Updated prompt" }
    });

    expect(updated?.name).toBe("Renamed");
    expect((updated?.runnerConfig as { prompt: string }).prompt).toBe("Updated prompt");
  });

  it("returns null when updating a non-existent agent", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    expect(store.updateAgent("missing", { name: "X" })).toBeNull();
  });

  it("deletes an agent and returns true; false for missing", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createAgent(makeAgent());
    expect(store.deleteAgent("agent-a")).toBe(true);
    expect(store.getAgent("agent-a")).toBeNull();
    expect(store.deleteAgent("agent-a")).toBe(false);
  });

  it("throws on duplicate agent id (PK conflict)", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    store.createAgent(makeAgent());
    expect(() => store.createAgent(makeAgent())).toThrow();
  });
});

async function storeWithWorkspace(): Promise<StateStore> {
  const store = new StateStore(":memory:");
  await store.load();
  store.setWorkspaces([makeWorkspace()]);
  await store.save();
  return store;
}

// "workspace-1" is the id produced by makeWorkspace()
const WS = "workspace-1";

describe("StateStore — Workspace Agent Mounting (Phase 4)", () => {
  it("mounts an agent to a workspace and lists it", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    const wa = store.mountAgentToWorkspace(
      WS,
      "agent-a",
      "worker",
      "Owns the docs surface in this workspace."
    );

    expect(wa.role).toBe("worker");
    expect(wa.name).toBe("Test Agent");
    expect(wa.workspaceDescription).toBe("Owns the docs surface in this workspace.");

    const list = store.listWorkspaceAgents(WS);
    expect(list).toHaveLength(1);
    expect(list[0]?.role).toBe("worker");
    expect(list[0]?.description).toBe("desc");
    expect(list[0]?.workspaceDescription).toBe(
      "Owns the docs surface in this workspace."
    );
  });

  it("retrieves a single workspace agent", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "coordinator");

    const wa = store.getWorkspaceAgent(WS, "agent-a");
    expect(wa?.role).toBe("coordinator");
    expect(store.getWorkspaceAgent(WS, "missing")).toBeNull();
  });

  it("unmounts an agent from a workspace", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "worker");

    expect(store.unmountAgentFromWorkspace(WS, "agent-a")).toBe(true);
    expect(store.listWorkspaceAgents(WS)).toHaveLength(0);
    expect(store.unmountAgentFromWorkspace(WS, "agent-a")).toBe(false);
  });

  it("updates workspace agent role", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "worker");

    const updated = store.updateWorkspaceAgentRole(WS, "agent-a", "coordinator");
    expect(updated?.role).toBe("coordinator");
  });

  it("updates workspace agent description without changing account description", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "worker");

    const updated = store.updateWorkspaceAgent(WS, "agent-a", {
      workspaceDescription: "Handle release checklists for this repo."
    });

    expect(updated?.description).toBe("desc");
    expect(updated?.workspaceDescription).toBe(
      "Handle release checklists for this repo."
    );
    expect(store.getWorkspaceAgent(WS, "agent-a")?.workspaceDescription).toBe(
      "Handle release checklists for this repo."
    );
  });

  it("returns null when updating role for unmounted agent", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    expect(store.updateWorkspaceAgentRole(WS, "agent-a", "worker")).toBeNull();
  });

  it("enforces single coordinator per workspace on mount", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent({ id: "agent-a" }));
    store.createAgent(makeAgent({ id: "agent-b", name: "Agent B" }));
    store.mountAgentToWorkspace(WS, "agent-a", "coordinator");

    expect(() => store.mountAgentToWorkspace(WS, "agent-b", "coordinator")).toThrow(
      "already has a coordinator"
    );
  });

  it("enforces single coordinator per workspace on role update", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent({ id: "agent-a" }));
    store.createAgent(makeAgent({ id: "agent-b", name: "Agent B" }));
    store.mountAgentToWorkspace(WS, "agent-a", "coordinator");
    store.mountAgentToWorkspace(WS, "agent-b", "worker");

    expect(() => store.updateWorkspaceAgentRole(WS, "agent-b", "coordinator")).toThrow(
      "already has a coordinator"
    );
  });

  it("allows re-assigning coordinator role to the same agent (idempotent)", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "coordinator");

    // updating the existing coordinator to coordinator again must succeed
    const updated = store.updateWorkspaceAgentRole(WS, "agent-a", "coordinator");
    expect(updated?.role).toBe("coordinator");
  });

  it("throws when mounting a missing agent", async () => {
    const store = await storeWithWorkspace();

    expect(() => store.mountAgentToWorkspace(WS, "ghost", "worker")).toThrow("Agent not found");
  });

  it("cascades workspace_agents deletion when agent is deleted", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "worker");
    expect(store.listWorkspaceAgents(WS)).toHaveLength(1);

    store.deleteAgent("agent-a");
    expect(store.listWorkspaceAgents(WS)).toHaveLength(0);
  });

  it("throws on duplicate mount of same agent to same workspace (PK conflict)", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "worker");

    expect(() => store.mountAgentToWorkspace(WS, "agent-a", "worker")).toThrow();
  });

  it("cascades workspace_agents deletion when workspace is deleted", async () => {
    const store = await storeWithWorkspace();

    store.createAgent(makeAgent());
    store.mountAgentToWorkspace(WS, "agent-a", "worker");
    expect(store.listWorkspaceAgents(WS)).toHaveLength(1);

    // Removing the workspace via setWorkspaces+save deletes the workspace row,
    // which should cascade to workspace_agents.
    store.setWorkspaces([]);
    await store.save();

    expect(store.listWorkspaceAgents(WS)).toHaveLength(0);
  });
});

describe("StateStore — Agent-driven board schema (Spec 01)", () => {
  // These tests exercise the raw DDL added by Spec 01. StateStore does not yet
  // expose public methods for threads/messages/plans (that's Spec 04); we reach
  // into the internal sqlite connection to confirm the migration applied and
  // round-trips cleanly.

  function getSqlite(store: StateStore): import("better-sqlite3").Database {
    return (store as unknown as { sqlite: import("better-sqlite3").Database })
      .sqlite;
  }

  it("creates threads / messages / plans / agent_sessions tables", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const sqlite = getSqlite(store);
    const rows = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?, ?, ?)"
      )
      .all("threads", "messages", "plans", "agent_sessions") as Array<{
      name: string;
    }>;
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("threads")).toBe(true);
    expect(names.has("messages")).toBe(true);
    expect(names.has("plans")).toBe(true);
    expect(names.has("agent_sessions")).toBe(true);
  });

  it("adds source / plan_id / assignee_agent_id columns to tasks", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const sqlite = getSqlite(store);
    const cols = sqlite
      .prepare("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has("source")).toBe(true);
    expect(byName.get("source")?.notnull).toBe(1);
    expect(byName.has("plan_id")).toBe(true);
    expect(byName.has("assignee_agent_id")).toBe(true);
  });

  it("round-trips a thread + message + plan insert/select", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    store.setWorkspaces([workspace]);
    await store.save();

    const sqlite = getSqlite(store);
    const now = new Date().toISOString();

    sqlite
      .prepare(
        `INSERT INTO threads
         (id, workspace_id, kind, coordinator_state, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("thread-1", workspace.id, "coordinator", "idle", now);

    sqlite
      .prepare(
        `INSERT INTO messages
         (id, thread_id, sender_type, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("msg-1", "thread-1", "user", "chat", JSON.stringify({ text: "hi" }), now);

    sqlite
      .prepare(
        `INSERT INTO plans
         (id, thread_id, proposer_agent_id, status, drafts, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "plan-1",
        "thread-1",
        "agent-1",
        "pending",
        JSON.stringify([{ title: "step 1", description: "do it" }]),
        now
      );

    const thread = sqlite
      .prepare("SELECT * FROM threads WHERE id = ?")
      .get("thread-1") as {
      workspace_id: string;
      kind: string;
      coordinator_state: string;
    };
    expect(thread.workspace_id).toBe(workspace.id);
    expect(thread.kind).toBe("coordinator");
    expect(thread.coordinator_state).toBe("idle");

    const msg = sqlite
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get("msg-1") as { payload: string; consumed_by_run_id: string | null };
    expect(JSON.parse(msg.payload)).toEqual({ text: "hi" });
    expect(msg.consumed_by_run_id).toBeNull();

    const plan = sqlite
      .prepare("SELECT * FROM plans WHERE id = ?")
      .get("plan-1") as { status: string; drafts: string };
    expect(plan.status).toBe("pending");
    expect(JSON.parse(plan.drafts)).toHaveLength(1);
  });

  it("enforces FK cascade: deleting a thread drops its messages and plans", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    store.setWorkspaces([workspace]);
    await store.save();

    const sqlite = getSqlite(store);
    const now = new Date().toISOString();

    sqlite
      .prepare(
        `INSERT INTO threads
         (id, workspace_id, kind, coordinator_state, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("thread-x", workspace.id, "coordinator", "idle", now);
    sqlite
      .prepare(
        `INSERT INTO messages
         (id, thread_id, sender_type, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("msg-x", "thread-x", "user", "chat", "{}", now);
    sqlite
      .prepare(
        `INSERT INTO plans
         (id, thread_id, proposer_agent_id, status, drafts, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("plan-x", "thread-x", "agent-1", "pending", "[]", now);

    sqlite.prepare("DELETE FROM threads WHERE id = ?").run("thread-x");

    const msgCount = (
      sqlite.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }
    ).c;
    const planCount = (
      sqlite.prepare("SELECT COUNT(*) AS c FROM plans").get() as { c: number }
    ).c;
    expect(msgCount).toBe(0);
    expect(planCount).toBe(0);
  });

  it("agent_sessions.thread_id is unique (one session per thread)", async () => {
    const store = new StateStore(":memory:");
    await store.load();

    const workspace = makeWorkspace();
    store.setWorkspaces([workspace]);
    await store.save();

    const sqlite = getSqlite(store);
    const now = new Date().toISOString();

    sqlite
      .prepare(
        `INSERT INTO threads
         (id, workspace_id, kind, coordinator_state, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("thread-s2", workspace.id, "coordinator", "idle", now);

    sqlite
      .prepare(
        `INSERT INTO agent_sessions
         (id, workspace_id, agent_id, thread_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("sess-1-a", workspace.id, "agent-1", "thread-s2", now);

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO agent_sessions
           (id, workspace_id, agent_id, thread_id, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run("sess-2-a", workspace.id, "agent-2", "thread-s2", now)
    ).toThrow(/UNIQUE/i);
  });
});
