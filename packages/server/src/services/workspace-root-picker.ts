import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";

import { AppError } from "../lib/errors.js";

const execFileAsync = promisify(execFile);

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandExecutor = (
  file: string,
  args: string[]
) => Promise<CommandResult>;

interface NativeWorkspaceRootPickerOptions {
  platform?: NodeJS.Platform;
  execCommand?: CommandExecutor;
}

interface CommandDescriptor {
  file: string;
  args: string[];
}

export interface WorkspaceRootPicker {
  pickRootPath(): Promise<string | null>;
}

function defaultExecCommand(
  file: string,
  args: string[]
): Promise<CommandResult> {
  return execFileAsync(file, args, {
    encoding: "utf8",
    windowsHide: true
  });
}

function getExecErrorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as ExecFileException).code;
  return code === null ? undefined : code;
}

function getExecErrorStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return "";
  }

  const stderr = (error as ExecFileException).stderr;
  return typeof stderr === "string" ? stderr.trim() : "";
}

function isMissingCommand(error: unknown): boolean {
  return getExecErrorCode(error) === "ENOENT";
}

function isMacOsCancellation(error: unknown): boolean {
  return /user canceled|\(-128\)/i.test(getExecErrorStderr(error));
}

function isLinuxCancellation(error: unknown): boolean {
  return getExecErrorCode(error) === 1 && getExecErrorStderr(error) === "";
}

function isWindowsCancellation(error: unknown): boolean {
  return getExecErrorCode(error) === 1 && getExecErrorStderr(error) === "";
}

function normalizePickedPath(stdout: string): string | null {
  const rootPath = stdout.trim();
  return rootPath ? rootPath : null;
}

function toPickerFailure(error: unknown): AppError {
  const stderr = getExecErrorStderr(error);

  return new AppError(
    500,
    "WORKSPACE_PICKER_FAILED",
    "Failed to open the local folder picker",
    stderr || undefined
  );
}

export class NativeWorkspaceRootPicker implements WorkspaceRootPicker {
  private readonly platform: NodeJS.Platform;

  private readonly execCommand: CommandExecutor;

  public constructor(options: NativeWorkspaceRootPickerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.execCommand = options.execCommand ?? defaultExecCommand;
  }

  public async pickRootPath(): Promise<string | null> {
    switch (this.platform) {
      case "darwin":
        return this.pickOnMacOs();
      case "linux":
        return this.pickOnLinux();
      case "win32":
        return this.pickOnWindows();
      default:
        throw new AppError(
          501,
          "WORKSPACE_PICKER_UNSUPPORTED",
          `Folder picker is not supported on ${this.platform}`
        );
    }
  }

  private async pickOnMacOs(): Promise<string | null> {
    try {
      const result = await this.execCommand("osascript", [
        "-e",
        'set selectedFolder to choose folder with prompt "Select workspace folder"',
        "-e",
        "POSIX path of selectedFolder"
      ]);

      return normalizePickedPath(result.stdout);
    } catch (error) {
      if (isMacOsCancellation(error)) {
        return null;
      }

      if (isMissingCommand(error)) {
        throw new AppError(
          501,
          "WORKSPACE_PICKER_UNAVAILABLE",
          "Folder picker requires osascript on macOS"
        );
      }

      throw toPickerFailure(error);
    }
  }

  private async pickOnLinux(): Promise<string | null> {
    const commands: CommandDescriptor[] = [
      {
        file: "zenity",
        args: ["--file-selection", "--directory", "--title=Select workspace folder"]
      },
      {
        file: "kdialog",
        args: [
          "--title",
          "Select workspace folder",
          "--getexistingdirectory",
          process.env.HOME ?? "."
        ]
      }
    ];

    let missingCommandCount = 0;

    for (const command of commands) {
      try {
        const result = await this.execCommand(command.file, command.args);
        return normalizePickedPath(result.stdout);
      } catch (error) {
        if (isLinuxCancellation(error)) {
          return null;
        }

        if (isMissingCommand(error)) {
          missingCommandCount += 1;
          continue;
        }

        throw toPickerFailure(error);
      }
    }

    if (missingCommandCount === commands.length) {
      throw new AppError(
        501,
        "WORKSPACE_PICKER_UNAVAILABLE",
        "Folder picker requires zenity or kdialog on Linux"
      );
    }

    throw new AppError(
      500,
      "WORKSPACE_PICKER_FAILED",
      "Failed to open the local folder picker"
    );
  }

  private async pickOnWindows(): Promise<string | null> {
    const commands: CommandDescriptor[] = [
      {
        file: "powershell",
        args: [
          "-NoProfile",
          "-Command",
          [
            "Add-Type -AssemblyName System.Windows.Forms;",
            "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
            "$dialog.Description = 'Select workspace folder';",
            "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
            "  [Console]::Out.Write($dialog.SelectedPath)",
            "}"
          ].join(" ")
        ]
      },
      {
        file: "pwsh",
        args: [
          "-NoProfile",
          "-Command",
          [
            "Add-Type -AssemblyName System.Windows.Forms;",
            "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
            "$dialog.Description = 'Select workspace folder';",
            "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
            "  [Console]::Out.Write($dialog.SelectedPath)",
            "}"
          ].join(" ")
        ]
      }
    ];

    let missingCommandCount = 0;

    for (const command of commands) {
      try {
        const result = await this.execCommand(command.file, command.args);
        return normalizePickedPath(result.stdout);
      } catch (error) {
        if (isWindowsCancellation(error)) {
          return null;
        }

        if (isMissingCommand(error)) {
          missingCommandCount += 1;
          continue;
        }

        throw toPickerFailure(error);
      }
    }

    if (missingCommandCount === commands.length) {
      throw new AppError(
        501,
        "WORKSPACE_PICKER_UNAVAILABLE",
        "Folder picker requires PowerShell on Windows"
      );
    }

    throw new AppError(
      500,
      "WORKSPACE_PICKER_FAILED",
      "Failed to open the local folder picker"
    );
  }
}
