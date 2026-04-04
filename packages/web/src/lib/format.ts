export function formatRelativeTime(input?: string): string {
  if (!input) {
    return "never";
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return input;
  }

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) {
    return "just now";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function titleCase(value: string): string {
  return value
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function formatTimestampRange(start: string, end: string): string {
  const startLabel = formatTimestamp(start);
  const endLabel = formatTimestamp(end);
  if (!startLabel || !endLabel || startLabel === endLabel) {
    return endLabel || startLabel;
  }

  return `${startLabel} - ${endLabel}`;
}

export function slugifyBranchPreview(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return slug || "task";
}

export function formatTaskBranchPreview(
  value: string,
  options: {
    omitGeneratedId?: boolean;
  } = {}
): string {
  const slug = slugifyBranchPreview(value);

  if (options.omitGeneratedId) {
    return `task/${slug}`;
  }

  return `task/<generated-id>-${slug}`;
}
