import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import type {
  AppState,
  GlobalSettings,
  Run,
  RunLogEntry,
  Task,
  Workspace
} from "@workhorse/contracts";

import {
  parseRunLogEntries,
  serializeRunLogEntry
} from "../lib/run-log.js";
import { resolveWorkspaceCodexSettings } from "../lib/codex-settings.js";
import { AppError } from "../lib/errors.js";
import { resolveGlobalSettings } from "../lib/global-settings.js";
import { createTaskWorktree } from "../lib/task-worktree.js";
import { resolveWorkspacePromptTemplates } from "../lib/workspace-prompt-templates.js";

const SCHEMA_VERSION = 6;

function migrateState(state: AppState): AppState {
  const settings = resolveGlobalSettings(state.settings);
  const workspaces = (Array.isArray(state.workspaces) ? state.workspaces : []).map(
    (workspace) =>
      ({
        ...workspace,
        codexSettings: resolveWorkspaceCodexSettings(workspace),
        promptTemplates: resolveWorkspacePromptTemplates(workspace)
      }) satisfies Workspace
  );
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const tasks = (Array.isArray(state.tasks) ? state.tasks : []).map((task) => {
    const withWorktree =
      "worktree" in task && task.worktree
        ? (task as Task)
        : (() => {
            const workspace = workspaceById.get(task.workspaceId);
            return {
              ...task,
              worktree: createTaskWorktree(task.id, task.title, { workspace })
            } as Task;
          })();

    // v6: backfill dependencies array
    if (!Array.isArray(withWorktree.dependencies)) {
      return { ...withWorktree, dependencies: [] } satisfies Task;
    }
    return withWorktree;
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    settings,
    workspaces,
    tasks,
    runs: Array.isArray(state.runs) ? state.runs : []
  };
}

export class StateStore {
  public readonly dataDir: string;

  public readonly stateFile: string;

  public readonly logsDir: string;

  private state: AppState = {
    schemaVersion: SCHEMA_VERSION,
    settings: resolveGlobalSettings(undefined),
    workspaces: [],
    tasks: [],
    runs: []
  };

  private writeBarrier: Promise<void> = Promise.resolve();

  public constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.stateFile = join(dataDir, "state.json");
    this.logsDir = join(dataDir, "logs");
  }

  public async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.logsDir, { recursive: true });

    try {
      await access(this.stateFile, constants.F_OK);
    } catch {
      await this.save();
      return;
    }

    const raw = await readFile(this.stateFile, "utf8");
    this.state = migrateState(JSON.parse(raw) as AppState);
    if (this.state.schemaVersion !== SCHEMA_VERSION) {
      this.state.schemaVersion = SCHEMA_VERSION;
    }
    await this.save();
  }

  public snapshot(): AppState {
    return {
      schemaVersion: this.state.schemaVersion,
      settings: {
        ...this.state.settings,
        openRouter: {
          ...this.state.settings.openRouter
        }
      },
      workspaces: [...this.state.workspaces],
      tasks: [...this.state.tasks],
      runs: [...this.state.runs]
    };
  }

  public getSettings(): GlobalSettings {
    return {
      ...this.state.settings,
      openRouter: {
        ...this.state.settings.openRouter
      }
    };
  }

  public listWorkspaces(): Workspace[] {
    return [...this.state.workspaces];
  }

  public listTasks(): Task[] {
    return [...this.state.tasks];
  }

  public listRuns(): Run[] {
    return [...this.state.runs];
  }

  public setWorkspaces(workspaces: Workspace[]): void {
    this.state.workspaces = workspaces;
  }

  public setSettings(settings: GlobalSettings): void {
    this.state.settings = settings;
  }

  public setTasks(tasks: Task[]): void {
    this.state.tasks = tasks;
  }

  public setRuns(runs: Run[]): void {
    this.state.runs = runs;
  }

  public createLogPath(runId: string): string {
    return join(this.logsDir, `${runId}.log`);
  }

  public async readLogEntries(runId: string): Promise<RunLogEntry[]> {
    const path = this.createLogPath(runId);
    try {
      const raw = await readFile(path, "utf8");
      return parseRunLogEntries(runId, raw);
    } catch {
      return [];
    }
  }

  public async appendLogEntry(runId: string, entry: RunLogEntry): Promise<void> {
    const path = this.createLogPath(runId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeRunLogEntry(entry), {
      encoding: "utf8",
      flag: "a"
    });
  }

  public async save(): Promise<void> {
    await this.withWriteLock(() => this.persistState(this.state));
  }

  public async updateState<T>(updater: (state: AppState) => T): Promise<T> {
    return this.withWriteLock(async () => {
      const nextState = structuredClone(this.state) as AppState;
      const result = updater(nextState);
      await this.persistState(nextState);
      this.state = nextState;
      return result;
    });
  }

  public async updateTask(
    taskId: string,
    updater: (task: Task) => Task
  ): Promise<Task> {
    return this.updateState((state) => {
      const taskIndex = state.tasks.findIndex((task) => task.id === taskId);
      if (taskIndex === -1) {
        throw new AppError(404, "TASK_NOT_FOUND", "Task not found");
      }

      state.tasks[taskIndex] = updater(state.tasks[taskIndex]!);
      return state.tasks[taskIndex];
    });
  }

  private async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.writeBarrier;
    let release: (() => void) | undefined;
    this.writeBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await work();
    } finally {
      release?.();
    }
  }

  private async persistState(state: AppState): Promise<void> {
    const tempPath = `${this.stateFile}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.stateFile);
  }
}
