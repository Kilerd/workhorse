import { describe, expect, it } from "vitest";

import { previewTemplate, resolveTemplate } from "./prompt-template.js";

describe("resolveTemplate", () => {
  it("preserves unknown variable tokens so template typos stay visible", () => {
    expect(
      resolveTemplate("Task: {{taskTitle}}\nMissing: {{taskTile}}", {
        taskTitle: "Implement feature"
      })
    ).toBe("Task: Implement feature\nMissing: {{taskTile}}");
  });

  it("clears known variables when their values are nullish", () => {
    expect(
      resolveTemplate("Prefix {{empty}} / {{missing}} / {{unset}} Suffix", {
        empty: "",
        missing: null,
        unset: undefined
      })
    ).toBe("Prefix  /  /  Suffix");
  });

  it("collapses repeated blank lines after substitutions", () => {
    expect(
      resolveTemplate(
        ["Top", "", "{{middle}}", "", "", "Bottom"].join("\n"),
        { middle: "" }
      )
    ).toBe(["Top", "", "Bottom"].join("\n"));
  });
});

describe("previewTemplate", () => {
  it("renders the default plan template with task and workspace context", () => {
    const preview = previewTemplate("plan");

    expect(preview).toContain("Task: 自定义工作区提示词设置");
    expect(preview).toContain(
      "Task description:\n让 workspace settings 支持自定义四类 prompt，并提供可视化 preview。"
    );
    expect(preview).toContain("Working directory: /Users/you/projects/workhorse");
    expect(preview).toContain("Base ref: origin/main");
    expect(preview).toContain("Task branch: task/custom-workspace-prompts");
  });

  it("keeps review metadata separated by blank lines in the default review preview", () => {
    const preview = previewTemplate("review");

    expect(preview).toContain(
      [
        "GitHub PR: https://github.com/acme/workhorse/pull/42",
        "",
        "PR title: feat: add workspace prompt templates"
      ].join("\n")
    );
  });
});
