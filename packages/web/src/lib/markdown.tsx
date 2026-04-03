import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; code: string }
  | { type: "heading"; depth: number; text: string };

function isSafeMarkdownHref(value: string): boolean {
  return /^(https?:\/\/|mailto:|\/|\.\/|\.\.\/|#)/i.test(value);
}

export function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|((?:https?:\/\/|mailto:)[^\s<]+)/g;
  let lastIndex = 0;
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }

    const key = `${keyPrefix}-${index}`;
    const [, label, href, code, strong, bareUrl] = match;

    if (label && href) {
      const normalizedHref = href.trim();
      if (isSafeMarkdownHref(normalizedHref)) {
        parts.push(
          <a
            key={key}
            href={normalizedHref}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] no-underline hover:underline"
            title={normalizedHref}
          >
            {label}
          </a>
        );
      } else {
        parts.push(match[0]);
      }
    } else if (bareUrl) {
      parts.push(
        <a
          key={key}
          href={bareUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--accent)] no-underline hover:underline"
        >
          {bareUrl}
        </a>
      );
    } else if (code) {
      parts.push(
        <code
          key={key}
          className="border border-border bg-[var(--surface-soft)] px-1 font-mono text-[0.8em]"
        >
          {code}
        </code>
      );
    } else if (strong) {
      parts.push(
        <strong key={key} className="font-semibold text-[var(--text)]">
          {strong}
        </strong>
      );
    } else {
      parts.push(match[0]);
    }

    lastIndex = start + match[0].length;
    index += 1;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push({
        type: "code",
        code: codeLines.join("\n")
      });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        depth: headingMatch[1]?.length ?? 1,
        text: headingMatch[2] ?? ""
      });
      index += 1;
      continue;
    }

    const listMatch = line.match(/^\s*((?:[-*+])|(?:\d+\.))\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1] ?? "");
      const items: string[] = [];

      while (index < lines.length) {
        const currentLine = lines[index] ?? "";
        const currentMatch = currentLine.match(/^\s*((?:[-*+])|(?:\d+\.))\s+(.+)$/);
        if (!currentMatch || /\d+\./.test(currentMatch[1] ?? "") !== ordered) {
          break;
        }

        items.push(currentMatch[2] ?? "");
        index += 1;
      }

      blocks.push({
        type: "list",
        ordered,
        items
      });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const currentLine = lines[index] ?? "";
      const currentTrimmed = currentLine.trim();
      if (!currentTrimmed) {
        break;
      }
      if (
        currentTrimmed.startsWith("```") ||
        /^#{1,3}\s+/.test(currentTrimmed) ||
        /^\s*((?:[-*+])|(?:\d+\.))\s+/.test(currentLine)
      ) {
        break;
      }

      paragraphLines.push(currentLine);
      index += 1;
    }

    blocks.push({
      type: "paragraph",
      text: paragraphLines.join("\n")
    });
  }

  return blocks;
}

export function renderMarkdownBlock(
  text: string,
  options: {
    className?: string;
    tone?: "default" | "danger" | "muted";
  } = {}
) {
  const { className, tone = "default" } = options;
  const blocks = parseMarkdownBlocks(text);

  return (
    <div
      className={cn(
        "grid gap-3 text-[0.9rem] leading-[1.76]",
        tone === "danger"
          ? "text-[var(--danger)]"
          : tone === "muted"
            ? "text-[var(--muted)]"
            : "text-[var(--text)]",
        className
      )}
    >
      {blocks.map((block, index) => {
        const key = `markdown-${index}`;

        if (block.type === "code") {
          return (
            <pre
              key={key}
              className="m-0 overflow-x-auto border border-border bg-[var(--surface-soft)] px-3 py-2 font-mono text-[0.72rem] leading-[1.72]"
            >
              {block.code}
            </pre>
          );
        }

        if (block.type === "heading") {
          const HeadingTag = block.depth === 1 ? "h3" : block.depth === 2 ? "h4" : "h5";

          return (
            <HeadingTag key={key} className="m-0 text-[0.84rem] font-semibold">
              {renderInlineMarkdown(block.text, key)}
            </HeadingTag>
          );
        }

        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";

          return (
            <ListTag
              key={key}
              className={cn(
                "m-0 grid gap-1 pl-5",
                block.ordered ? "list-decimal" : "list-disc"
              )}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-item-${itemIndex}`}>
                  {renderInlineMarkdown(item, `${key}-item-${itemIndex}`)}
                </li>
              ))}
            </ListTag>
          );
        }

        return (
          <p key={key} className="m-0 whitespace-pre-wrap break-words">
            {renderInlineMarkdown(block.text, key).map((node, nodeIndex) => (
              <Fragment key={`${key}-node-${nodeIndex}`}>{node}</Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
