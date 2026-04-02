import { describe, expect, it, vi } from "vitest";

import { AppError } from "../lib/errors.js";
import { NativeWorkspaceRootPicker } from "./workspace-root-picker.js";

function createExecError(overrides: Record<string, unknown> = {}) {
  return Object.assign(new Error("command failed"), {
    code: 1,
    stdout: "",
    stderr: "",
    ...overrides
  });
}

describe("NativeWorkspaceRootPicker", () => {
  it("returns the selected path on macOS", async () => {
    const execCommand = vi.fn().mockResolvedValue({
      stdout: "/Users/example/projects/app\n",
      stderr: ""
    });
    const picker = new NativeWorkspaceRootPicker({
      platform: "darwin",
      execCommand
    });

    await expect(picker.pickRootPath()).resolves.toBe("/Users/example/projects/app");
    expect(execCommand).toHaveBeenCalledWith("osascript", [
      "-e",
      'set selectedFolder to choose folder with prompt "Select workspace folder"',
      "-e",
      "POSIX path of selectedFolder"
    ]);
  });

  it("treats macOS dialog cancellation as null", async () => {
    const picker = new NativeWorkspaceRootPicker({
      platform: "darwin",
      execCommand: vi.fn().mockRejectedValue(
        createExecError({
          stderr: "execution error: User canceled. (-128)"
        })
      )
    });

    await expect(picker.pickRootPath()).resolves.toBeNull();
  });

  it("falls back to kdialog when zenity is unavailable on Linux", async () => {
    const execCommand = vi
      .fn()
      .mockRejectedValueOnce(createExecError({ code: "ENOENT" }))
      .mockResolvedValueOnce({
        stdout: "/tmp/workspace\n",
        stderr: ""
      });
    const picker = new NativeWorkspaceRootPicker({
      platform: "linux",
      execCommand
    });

    await expect(picker.pickRootPath()).resolves.toBe("/tmp/workspace");
    expect(execCommand).toHaveBeenNthCalledWith(1, "zenity", [
      "--file-selection",
      "--directory",
      "--title=Select workspace folder"
    ]);
    expect(execCommand).toHaveBeenNthCalledWith(
      2,
      "kdialog",
      expect.arrayContaining(["--getexistingdirectory"])
    );
  });

  it("treats Linux dialog cancellation as null", async () => {
    const picker = new NativeWorkspaceRootPicker({
      platform: "linux",
      execCommand: vi.fn().mockRejectedValue(
        createExecError({
          code: 1,
          stderr: ""
        })
      )
    });

    await expect(picker.pickRootPath()).resolves.toBeNull();
  });

  it("reports unavailable when no Linux picker command exists", async () => {
    const picker = new NativeWorkspaceRootPicker({
      platform: "linux",
      execCommand: vi.fn().mockRejectedValue(
        createExecError({
          code: "ENOENT"
        })
      )
    });

    const result = picker.pickRootPath();

    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({
      status: 501,
      code: "WORKSPACE_PICKER_UNAVAILABLE"
    });
  });
});
