import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_PORT = Number(process.env.WORKHORSE_PORT ?? 3484);
export const DATA_DIR = resolve(
  process.env.WORKHORSE_DATA_DIR ?? `${homedir()}/.workhorse`
);
