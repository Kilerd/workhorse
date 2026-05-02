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
