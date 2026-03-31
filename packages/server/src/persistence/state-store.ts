import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import type { AppState, Run, Task, Workspace } from "@workhorse/contracts";

const SCHEMA_VERSION = 1;

export class StateStore {
  public readonly dataDir: string;

  public readonly stateFile: string;

  public readonly logsDir: string;

  private state: AppState = {
    schemaVersion: SCHEMA_VERSION,
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
    this.state = JSON.parse(raw) as AppState;
  }

  public snapshot(): AppState {
    return {
      schemaVersion: this.state.schemaVersion,
      workspaces: [...this.state.workspaces],
      tasks: [...this.state.tasks],
      runs: [...this.state.runs]
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

  public setTasks(tasks: Task[]): void {
    this.state.tasks = tasks;
  }

  public setRuns(runs: Run[]): void {
    this.state.runs = runs;
  }

  public createLogPath(runId: string): string {
    return join(this.logsDir, `${runId}.log`);
  }

  public async readLog(runId: string): Promise<string> {
    const path = this.createLogPath(runId);
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }

  public async appendLog(runId: string, chunk: string): Promise<void> {
    const path = this.createLogPath(runId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, chunk, {
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
