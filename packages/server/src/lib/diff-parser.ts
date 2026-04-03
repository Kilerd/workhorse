export interface DiffFile {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
}

export function parseUnifiedDiff(raw: string): DiffFile[] {
  if (!raw.trim()) {
    return [];
  }

  const files: DiffFile[] = [];
  const segments = raw.split(/^diff --git /mu).filter(Boolean);

  for (const segment of segments) {
    const lines = segment.split("\n");
    const path = extractFilePath(lines);
    if (!path) {
      continue;
    }

    let additions = 0;
    let deletions = 0;
    const patchLines: string[] = [];
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        inHunk = true;
        patchLines.push(line);
        continue;
      }

      if (!inHunk) {
        continue;
      }

      patchLines.push(line);

      if (line.startsWith("+") && !line.startsWith("+++")) {
        additions += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions += 1;
      }
    }

    files.push({
      path,
      patch: patchLines.join("\n"),
      additions,
      deletions
    });
  }

  return files;
}

function extractFilePath(lines: string[]): string | undefined {
  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      return line.slice("+++ b/".length);
    }

    if (line.startsWith("+++ /dev/null")) {
      for (const prev of lines) {
        if (prev.startsWith("--- a/")) {
          return prev.slice("--- a/".length);
        }
      }
    }
  }

  const firstLine = lines[0];
  if (firstLine) {
    const match = /^a\/(.+?) b\//u.exec(firstLine);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}
