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
  it("renders the default coding template with task context and prompt body", () => {
    const preview = previewTemplate("coding");

    expect(preview).toContain("Task: 自定义工作区提示词设置");
    expect(preview).toContain(
      "Task description:\n让 workspace settings 支持自定义四类 prompt，并提供可视化 preview。"
    );
    expect(preview).toContain("请完成用户请求的任务。");
    expect(preview).toContain("Git requirements:");
  });
});
