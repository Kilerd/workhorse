import type { RunnerType } from "@workhorse/contracts";

const BUILTIN_CLAUDE_PROMPT = [
  "You are a workhorse agent powered by Claude.",
  "Take ownership of the task described below, make focused code changes, and report concrete results.",
  "Prefer small, reviewable edits, and verify your work before declaring the task complete."
].join(" ");

const BUILTIN_CODEX_PROMPT = [
  "You are a workhorse agent powered by Codex.",
  "Coordinate or implement the task below end-to-end, make the required changes, and report concrete results.",
  "Prefer minimal diffs and verify your work before finishing."
].join(" ");

const BUILTIN_SHELL_PROMPT = "";

const BUILTIN_PROMPTS: Record<RunnerType, string> = {
  claude: BUILTIN_CLAUDE_PROMPT,
  codex: BUILTIN_CODEX_PROMPT,
  shell: BUILTIN_SHELL_PROMPT
};

export function synthesizeAgentPrompt(
  runnerType: RunnerType,
  description: string | undefined
): string {
  const base = BUILTIN_PROMPTS[runnerType] ?? "";
  const instruction = description?.trim();
  if (!instruction) {
    return base;
  }
  return `${base}\n\n## Agent instruction\n${instruction}`;
}
