import { useMemo, useState } from "react";
import type { TaskDiffFile } from "@workhorse/contracts";

import { cn } from "@/lib/utils";

interface Props {
  files: TaskDiffFile[];
  baseRef: string;
  headRef: string;
  isLoading?: boolean;
  error?: string | null;
}

export function DiffViewer({ files, baseRef, headRef, isLoading, error }: Props) {
  if (isLoading) {
    return (
      <div className="grid h-full place-items-center text-[0.8rem] text-[var(--muted)]">
        Loading diff...
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid h-full place-items-center text-[0.8rem] text-[var(--danger)]">
        {error}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="grid h-full place-items-center text-[0.8rem] text-[var(--muted)]">
        No file changes detected between {baseRef} and HEAD.
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {files.map((file) => (
        <DiffFileCard key={file.path} file={file} />
      ))}
    </div>
  );
}

// --- Hunk line number computation ---

interface DiffLine {
  type: "hunk" | "add" | "del" | "ctx";
  text: string;
  oldNum?: number;
  newNum?: number;
}

function parsePatchLines(patch: string): DiffLine[] {
  const raw = patch.split("\n");
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const text of raw) {
    if (text.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)/u.exec(text);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      result.push({ type: "hunk", text });
      continue;
    }

    if (text.startsWith("+")) {
      result.push({ type: "add", text, newNum: newLine });
      newLine += 1;
    } else if (text.startsWith("-")) {
      result.push({ type: "del", text, oldNum: oldLine });
      oldLine += 1;
    } else {
      result.push({ type: "ctx", text, oldNum: oldLine, newNum: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return result;
}

// --- File card ---

function DiffFileCard({ file }: { file: TaskDiffFile }) {
  const [collapsed, setCollapsed] = useState(false);
  const lines = useMemo(
    () => (file.patch ? parsePatchLines(file.patch) : []),
    [file.patch]
  );

  return (
    <div className="border-b border-border">
      {/* Sticky file header */}
      <button
        type="button"
        className="sticky top-0 z-10 flex w-full items-center gap-3 border-b border-border bg-[var(--panel)] px-4 py-2 text-left hover:brightness-95"
        onClick={() => setCollapsed((prev) => !prev)}
      >
        <span className="font-mono text-[0.64rem] text-[var(--muted)]">
          {collapsed ? "\u25B6" : "\u25BC"}
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-[0.74rem] font-medium text-foreground">
          {file.path}
        </code>
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </button>

      {/* Diff body */}
      {!collapsed && lines.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[0.68rem] leading-[1.7]">
            <tbody>
              {lines.map((line, index) => (
                <DiffLineRow key={index} line={line} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// --- Diff stat bar (the colored +/- blocks like GitHub) ---

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const blocks = 5;
  const addBlocks = total > 0 ? Math.round((additions / total) * blocks) : 0;
  const delBlocks = total > 0 ? blocks - addBlocks : 0;

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="font-mono text-[0.64rem] text-[var(--success)]">+{additions}</span>
      <span className="font-mono text-[0.64rem] text-[var(--danger)]">-{deletions}</span>
      <span className="flex gap-px">
        {Array.from({ length: addBlocks }, (_, i) => (
          <span key={`a${i}`} className="inline-block size-[7px] rounded-[1px] bg-[#3fb950]" />
        ))}
        {Array.from({ length: delBlocks }, (_, i) => (
          <span key={`d${i}`} className="inline-block size-[7px] rounded-[1px] bg-[#f85149]" />
        ))}
      </span>
    </span>
  );
}

// --- Single diff line row ---

const lineNumClass =
  "w-[1px] min-w-[3.2em] select-none whitespace-nowrap px-2 text-right align-top text-[var(--muted)] opacity-50";

function DiffLineRow({ line }: { line: DiffLine }) {
  if (line.type === "hunk") {
    return (
      <tr className="bg-[rgba(104,199,246,0.13)]">
        <td className={cn(lineNumClass, "bg-[rgba(104,199,246,0.18)]")} />
        <td className={cn(lineNumClass, "bg-[rgba(104,199,246,0.18)]")} />
        <td className="whitespace-pre px-3 text-[rgba(104,199,246,0.9)]">{line.text}</td>
      </tr>
    );
  }

  if (line.type === "add") {
    return (
      <tr className="bg-[rgba(63,185,80,0.1)]">
        <td className={cn(lineNumClass, "bg-[rgba(63,185,80,0.15)]")} />
        <td className={cn(lineNumClass, "bg-[rgba(63,185,80,0.15)]")}>{line.newNum}</td>
        <td className="whitespace-pre px-3 text-foreground">{line.text.slice(1)}</td>
      </tr>
    );
  }

  if (line.type === "del") {
    return (
      <tr className="bg-[rgba(248,81,73,0.1)]">
        <td className={cn(lineNumClass, "bg-[rgba(248,81,73,0.12)]")}>{line.oldNum}</td>
        <td className={cn(lineNumClass, "bg-[rgba(248,81,73,0.12)]")} />
        <td className="whitespace-pre px-3 text-foreground">{line.text.slice(1)}</td>
      </tr>
    );
  }

  return (
    <tr>
      <td className={lineNumClass}>{line.oldNum}</td>
      <td className={lineNumClass}>{line.newNum}</td>
      <td className="whitespace-pre px-3 text-foreground">{line.text.slice(1)}</td>
    </tr>
  );
}
