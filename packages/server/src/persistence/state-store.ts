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
import { resolveGlobalSettings } from "../lib/global-settings.js";
import { createTaskWorktree } from "../lib/task-worktree.js";
import { resolveWorkspacePromptTemplates } from "../lib/workspace-prompt-templates.js";

const SCHEMA_VERSION = 5;

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
    if ("worktree" in task && task.worktree) {
      return task as Task;
    }

    const workspace = workspaceById.get(task.workspaceId);
    return {
      ...task,
      worktree: createTaskWorktree(task.id, task.title, {
        workspace
      })
    } satisfies Task;
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
    const tempPath = `${this.stateFile}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.stateFile);
  }
}
