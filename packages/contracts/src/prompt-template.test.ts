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
  it("renders the default plan template with its sample variables", () => {
    const preview = previewTemplate("plan");

    expect(preview).toContain("Task: 自定义工作区提示词设置");
    expect(preview).toContain("Working directory: /Users/you/projects/workhorse");
    expect(preview).toContain("Base ref: origin/main");
  });
});
