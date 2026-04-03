import type { RunLogEntry } from "@workhorse/contracts";
import type { LiveLogCommandExecutionGroupStreamItem } from "@/components/live-log-entries";
import { normalizeToolTitle } from "@/components/live-log-entries";

export type CommandIntent = "build" | "command" | "git" | "read" | "search" | "test";

export function getCommandIntent(text: string): CommandIntent {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .find(Boolean);

  if (!firstLine) {
    return "command";
  }

  if (/^(rg|grep|fd|find)\b/.test(firstLine) || firstLine.includes(" search ")) {
    return "search";
  }

  if (
    /^(sed|cat|head|tail|less|more|awk|cut)\b/.test(firstLine) ||
    firstLine.startsWith("bat ") ||
    firstLine.startsWith("open ")
  ) {
    return "read";
  }

  if (
    firstLine.includes("npm run test") ||
    firstLine.includes("pnpm run test") ||
    firstLine.includes("yarn test") ||
    firstLine.includes("vitest") ||
    firstLine.includes("jest") ||
    firstLine.includes("pytest") ||
    firstLine.includes("cargo test")
  ) {
    return "test";
  }

  if (
    firstLine.includes("npm run build") ||
    firstLine.includes("pnpm run build") ||
    firstLine.includes("yarn build") ||
    firstLine.includes("vite build") ||
    firstLine.includes("tsc ") ||
    firstLine === "tsc" ||
    firstLine.includes("cargo build")
  ) {
    return "build";
  }

  if (/^git\s+(status|diff|show|log|branch|grep|rev-parse)\b/.test(firstLine)) {
    return "git";
  }

  return "command";
}

export function getIntentLabel(intent: CommandIntent, count: number): string {
  switch (intent) {
    case "read":
      return count === 1 ? "Read a file" : `Read ${count} files`;
    case "search":
      return count === 1 ? "Searched code" : `Searched code ${count} times`;
    case "test":
      return count === 1 ? "Ran tests" : `Ran ${count} test commands`;
    case "build":
      return count === 1 ? "Built the project" : `Ran ${count} build commands`;
    case "git":
      return count === 1 ? "Checked git state" : `Checked git state ${count} times`;
    default:
      return count === 1 ? "Ran a command" : `Ran ${count} commands`;
  }
}

export function getToolActivityLabel(entry: RunLogEntry, count = 1): string {
  const itemType = entry.metadata?.itemType?.toLowerCase() ?? "";

  if (itemType.includes("filesearch")) {
    return count === 1 ? "Searched code" : `Searched code ${count} times`;
  }

  if (itemType.includes("filechange")) {
    return count === 1 ? "Edited a file" : `Edited ${count} files`;
  }

  if (itemType.includes("command")) {
    return getIntentLabel(getCommandIntent(entry.text), count);
  }

  const title = normalizeToolTitle(entry);
  if (count === 1) {
    return title;
  }

  return `${count} ${title.toLowerCase()} actions`;
}

export function getCommandGroupLabel(item: LiveLogCommandExecutionGroupStreamItem): string {
  const intents = item.items.map(({ entry }) => getCommandIntent(entry.text));
  const [firstIntent] = intents;
  const sameIntent = Boolean(firstIntent) && intents.every((intent) => intent === firstIntent);

  return getIntentLabel(sameIntent && firstIntent ? firstIntent : "command", item.items.length);
}
