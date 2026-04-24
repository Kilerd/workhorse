import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { renderMarkdownBlock } from "./markdown";

describe("renderMarkdownBlock", () => {
  it("renders common markdown structures for thread messages", () => {
    const html = renderToStaticMarkup(
      renderMarkdownBlock(
        [
          "# Summary",
          "",
          "Use **bold** and `code` and [docs](/docs/specs/agent-driven-board/README.md).",
          "",
          "- first item",
          "- second item",
          "",
          "```ts",
          "const ok = true;",
          "```"
        ].join("\n")
      )
    );

    expect(html).toContain("<h3");
    expect(html).toContain("<strong");
    expect(html).toContain("<code");
    expect(html).toContain("<a");
    expect(html).toContain("<ul");
    expect(html).toContain("<pre");
    expect(html).toContain("const ok = true;");
  });
});
