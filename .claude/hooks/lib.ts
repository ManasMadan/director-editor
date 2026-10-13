/**
 * Shared helpers for Claude Code hooks. Hooks receive a JSON event on stdin and answer
 * with JSON on stdout (https://code.claude.com/docs/en/hooks). Keep them fast: they run
 * on every matching tool call.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { $ } from "bun";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Claude Code sets it for its hooks, which turbo never runs
export const ROOT = process.env.CLAUDE_PROJECT_DIR ?? join(import.meta.dirname, "../..");
export const STATE_DIR = join(ROOT, ".claude/.state");
mkdirSync(STATE_DIR, { recursive: true });

export interface HookInput {
  session_id: string;
  hook_event_name: string;
  cwd: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    command?: string;
    [key: string]: unknown;
  };
  stop_hook_active?: boolean;
  source?: string;
  /** SubagentStop: which agent finished, and its final answer. */
  agent_type?: string;
  last_assistant_message?: string;
  /** PostToolUseFailure: what the failed call said. */
  error?: string;
}

/** What a hook answers: JSON for Claude Code, or nothing. */
export type HookOutput = Record<string, unknown> | undefined;

interface Streams {
  /** Where the event comes from, and the answer and a guard's refusal go. */
  stdin?: { text(): Promise<string> };
  stdout?: { write(text: string): unknown };
  stderr?: { write(text: string): unknown };
}

/**
 * Runs a hook: reads its event from stdin, writes the handler's answer as JSON and
 * returns the exit code. A guard passes `failClosed`: an event it can't read blocks the
 * tool call (exit 2, the reason on stderr for Claude) instead of letting it through.
 */
export async function runHook(
  handler: (input: HookInput) => HookOutput | Promise<HookOutput>,
  {
    failClosed = false,
    stdin = Bun.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
  }: Streams & { failClosed?: boolean } = {},
): Promise<number> {
  let input: HookInput;
  try {
    input = JSON.parse(await stdin.text()) as HookInput;
  } catch (error) {
    if (!failClosed) {
      throw error;
    }
    stderr.write(`The hook couldn't read its event, so the call is blocked: ${String(error)}`);
    return 2;
  }
  const output = await handler(input);
  if (output) {
    stdout.write(JSON.stringify(output));
  }
  return 0;
}

/** The text an Edit, MultiEdit or Write replaces and writes, for rules that look at it. */
export function editedText(input: HookInput): { before?: string; after?: string } {
  const tool = input.tool_input ?? {};
  const edits = Array.isArray(tool.edits)
    ? (tool.edits as { old_string?: unknown; new_string?: unknown }[])
    : [tool];
  const join = (values: unknown[]) => {
    const texts = values.filter((value): value is string => typeof value === "string");
    return texts.length ? texts.join("\n") : undefined;
  };
  return {
    before: join(edits.map((edit) => edit.old_string)),
    after: join([...edits.map((edit) => edit.new_string), tool.content]),
  };
}

/**
 * A fingerprint of the working tree's content: the diff against HEAD and the content of
 * every untracked file. Names and line counts aren't enough: rewriting an untracked file,
 * or changing a line that was already changed, keeps both the same.
 */
export async function treeFingerprint(cwd = ROOT): Promise<string> {
  const diff = await $`git diff HEAD --binary`.cwd(cwd).quiet().nothrow().text();
  const untracked = (
    await $`git ls-files -o --exclude-standard -z`.cwd(cwd).quiet().nothrow().text()
  )
    .split("\0")
    .filter(Boolean);
  const hashes = untracked.length
    ? await $`git hash-object -- ${untracked}`.cwd(cwd).quiet().nothrow().text()
    : "";
  const lines = untracked.map((file, index) => `${file} ${hashes.split("\n")[index] ?? ""}`);
  return new Bun.CryptoHasher("sha256").update(diff).update(lines.join("\n")).digest("hex");
}

/** Where the turn's starting fingerprint and its Stop re-check count are kept. */
export const turnFile = (session: string) => join(STATE_DIR, `turn-${session}.txt`);
export const stopCountFile = (session: string) => join(STATE_DIR, `stop-${session}.count`);
/** The tree the Stop hook last asked for the full checks on (so it asks once per state). */
export const askedFile = (session: string) => join(STATE_DIR, `asked-${session}.txt`);
/** Whether the session has had the hint about a failed repo command (tool-failure.ts). */
export const hintedFile = (session: string) => join(STATE_DIR, `hinted-${session}.txt`);
/** Every file of a session's state, which the session's end removes. */
export const sessionFiles = [turnFile, stopCountFile, askedFile, hintedFile];

/** Whether `path` is on `branch`, i.e. it has shipped. */
export function isShipped(branch: string, path: string, cwd = ROOT): boolean {
  return spawnSync("git", ["cat-file", "-e", `${branch}:${path}`], { cwd }).status === 0;
}

/** Runs a command quietly, whatever its exit code; its code and output. */
export async function shell(command: string[], cwd = ROOT) {
  const result = await $`${command}`.cwd(cwd).quiet().nothrow();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Files changed against HEAD, untracked ones included, that still exist. */
export async function changedFiles(cwd = ROOT): Promise<string[]> {
  const tracked = await $`git diff HEAD --name-only --diff-filter=d -z`
    .cwd(cwd)
    .quiet()
    .nothrow()
    .text();
  const untracked = await $`git ls-files -o --exclude-standard -z`
    .cwd(cwd)
    .quiet()
    .nothrow()
    .text();
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))].sort();
}

/** The repository's default branch (origin's HEAD), for "does it fail there too". */
export async function defaultBranch(cwd = ROOT): Promise<string> {
  const ref = await $`git symbolic-ref --quiet --short refs/remotes/origin/HEAD`
    .cwd(cwd)
    .quiet()
    .nothrow()
    .text();
  return ref.trim().replace(/^origin\//, "") || "master";
}

/** Repo-relative path of the file a tool call targets, or null. */
export function targetPath(input: HookInput): string | null {
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  return typeof file === "string" ? relative(ROOT, file) : null;
}

/** A hook's entry point for `runMain` (scripts/lib.ts): runs `handler` as runHook does. */
export function hookMain(
  handler: Parameters<typeof runHook>[0],
  options?: Parameters<typeof runHook>[1],
) {
  return () => runHook(handler, options);
}
