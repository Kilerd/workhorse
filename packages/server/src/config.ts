import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_PORT = Number(process.env.WORKHORSE_PORT ?? 3484);
export const DATA_DIR = resolve(
  process.env.WORKHORSE_DATA_DIR ?? `${homedir()}/.workhorse`
);

export function getGitReviewMonitorIntervalMs(): number {
  const raw = process.env.WORKHORSE_GIT_REVIEW_MONITOR_INTERVAL_MS?.trim();
  if (!raw) {
    return 60_000;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 60_000;
  }

  return parsed;
}
