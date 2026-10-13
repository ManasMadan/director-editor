/** Small helpers shared by the repo scripts (setup, doctor, env:set). */
import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv as parseEnvFile } from "node:util";

export const ROOT = join(import.meta.dirname, "..");
export const ENV_PATH = join(ROOT, ".env");
export const ENV_EXAMPLE_PATH = join(ROOT, ".env.example");

/** Values in .env.example that must never reach a real environment. */
// By path: scripts run before `bun install` (setup) and this module uses only Node built-ins.
export { PLACEHOLDER } from "../packages/testing/src/secrets";

/** Parsed the way the services read it: Node's own `--env-file` parser. */
export function parseEnv(text: string): Map<string, string> {
  const entries = Object.entries(parseEnvFile(text));
  return new Map(entries.filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Whether `error` is the file system's `code` (ENOENT, EEXIST, ...). */
export const errno = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

/** The file's variables; none when there's no file. */
export function readEnv(path: string): Map<string, string> {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if (errno(error, "ENOENT")) {
      return new Map();
    }
    throw error;
  }
}

/**
 * A value as a .env line spells it, so that Node's `--env-file` (the services) and Bun's
 * (the AI service's dev commands, the repo scripts) both read it back unchanged: bare
 * when it's plain, else single-quoted, else double-quoted for newlines. Throws for what
 * no spelling carries through both: `$` (Bun expands it even in single quotes, Node
 * never does), or a value needing both kinds of quote.
 */
export function envLine(key: string, value: string): string {
  if (value.includes("$")) {
    throw new Error(
      `${key}: a value with "$" can't be written so both Node and Bun read it the same (Bun expands it). Choose one without.`,
    );
  }
  if (/^[\w@%+=:,./-]*$/.test(value)) {
    return `${key}=${value}`;
  }
  if (!value.includes("'") && !value.includes("\n")) {
    return `${key}='${value}'`;
  }
  if (!value.includes('"') && !value.includes("\\")) {
    return `${key}="${value.replaceAll("\n", "\\n")}"`;
  }
  throw new Error(`${key}: a value with both quotes and a newline or backslash can't go in .env.`);
}

/** The line that sets `key` (a line, not a comment), for replacing or removing it. */
const keyLine = (key: string) =>
  new RegExp(`^\\s*(export\\s+)?${key.replace(/[^\w]/g, "\\$&")}\\s*=.*$\\n?`, "m");

/**
 * Rewrites the file through one open handle: read and written as the same file, never
 * checked by path first and opened again (another process could swap it in between).
 * `edit` returns the new text, or undefined to leave the file alone; returns whether it
 * wrote. `flags` without O_CREAT throws ENOENT for a missing file.
 */
function editFile(path: string, flags: number, edit: (text: string) => string | undefined) {
  const fd = openSync(path, flags, 0o600);
  try {
    const next = edit(readFileSync(fd, "utf8"));
    if (next === undefined) {
      return false;
    }
    ftruncateSync(fd);
    writeSync(fd, next, 0);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Sets or appends one KEY=value line, preserving every other line and comment. */
export function writeEnvValue(path: string, key: string, value: string) {
  const line = envLine(key, value);
  const pattern = keyLine(key);
  // A function replacement: a string one would read `$&` and `$$` in the line as patterns.
  editFile(path, constants.O_RDWR | constants.O_CREAT, (text) =>
    pattern.test(text)
      ? text.replace(pattern, () => `${line}\n`)
      : `${text.replace(/\n?$/, "\n")}${line}\n`,
  );
}

/** Removes KEY's line; returns whether there was one. */
export function removeEnvValue(path: string, key: string): boolean {
  const pattern = keyLine(key);
  try {
    return editFile(path, constants.O_RDWR, (text) =>
      pattern.test(text) ? text.replace(pattern, "") : undefined,
    );
  } catch (error) {
    if (errno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/** What a thrown value says: its message, or the value itself when it isn't an Error. */
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const ok = (message: string) => console.log(`  \x1b[32m✔\x1b[0m ${message}`);
export const warn = (message: string) => console.log(`  \x1b[33m!\x1b[0m ${message}`);
export const fail = (message: string) => console.log(`  \x1b[31m✖\x1b[0m ${message}`);

/** What a command did: its exit status (null when it couldn't start) and its output. */
export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** How the scripts run a command; tests pass a stand-in that records what would run. */
export type Run = (command: string, args: string[], options?: SpawnSyncOptions) => Ran;

/**
 * Runs a command to the end (spawnSync), its output as text unless `stdio` sends it
 * elsewhere. No output limit: a lint or test run can print more than spawnSync's 1 MB.
 */
export function runSync(command: string, args: string[], options: SpawnSyncOptions = {}): Ran {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: Infinity, ...options });
  return {
    status: result.status ?? null,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/** Whether something accepts connections on `host`:`port` within `timeoutMs`. */
export async function listening(port: number, timeoutMs = 1000, host = "127.0.0.1") {
  const socket = connect({ host, port });
  const open = await Promise.race([
    once(socket, "connect").then(
      () => true,
      () => false,
    ),
    sleep(timeoutMs, false, { ref: false }),
  ]);
  socket.destroy();
  return open;
}

/**
 * A script's entry point: `await runMain(import.meta, main)` runs `main` when the file is
 * run (`bun scripts/x.ts`), not when a test imports it, and exits with the code it
 * returns (0 when it returns none). `main` is passed as it is, never wrapped, so a test
 * that imports the file leaves nothing of it uncovered.
 */
export async function runMain(
  meta: { main: boolean },
  main: () => unknown,
  exit: (code: number) => void = process.exit,
) {
  if (meta.main) {
    const code = await main();
    exit(typeof code === "number" ? code : 0);
  }
}
