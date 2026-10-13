/**
 * SessionStart: give Claude a short health summary of the machine (tools, .env drift,
 * local services) from `bun run doctor`, and after a compaction the files the working
 * tree has changed, which the summary may have dropped. A clean report is cached for 10
 * minutes so starting a session stays instant; one with problems is checked afresh each
 * time, so a fixed problem (Docker started) isn't reported again. The doctor gets 20
 * seconds, inside the hook's 30. It also puts .claude/bin on the PATH of Claude's shell,
 * through the file Claude Code reads exports from, so Playwright's official skill finds the
 * `playwright-cli` command it runs.
 */

import { appendFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { runMain } from "../../scripts/lib";
import { changedFiles, type HookInput, hookMain, ROOT, STATE_DIR } from "./lib";

const DOCTOR_TIMEOUT_MS = 20_000;
const FRESH_MS = 10 * 60_000;
const BIN = join(import.meta.dirname, "../bin");

/** Runs the doctor, killed after `timeoutMs`; its exit code (null when killed) and output. */
export async function runDoctor(
  command = ["bun", "scripts/doctor.ts"],
  timeoutMs = DOCTOR_TIMEOUT_MS,
) {
  const run = Bun.spawn(command, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
    timeout: timeoutMs,
  });
  const stdout = await new Response(run.stdout).text();
  await run.exited;
  return { exitCode: run.signalCode ? null : run.exitCode, stdout };
}

/** The doctor's summary, from `cache` while a clean one is fresh. */
async function summary(doctor: typeof runDoctor, cache: string) {
  if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs < FRESH_MS) {
    return Bun.file(cache).text();
  }
  const { exitCode, stdout } = await doctor();
  if (exitCode === null) {
    return `The doctor didn't finish in ${DOCTOR_TIMEOUT_MS / 1000} s, so the machine wasn't checked. Run \`bun run doctor\` if the task needs the local services.\n`;
  }
  const text = stripVTControlCharacters(stdout);
  if (exitCode === 0) {
    await Bun.write(cache, text);
  } else {
    rmSync(cache, { force: true });
  }
  return text;
}

/** The context Claude starts the session with. */
export async function sessionStart(
  input: HookInput,
  {
    doctor = runDoctor,
    cache = join(STATE_DIR, "doctor.txt"),
    changed = changedFiles,
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Claude Code sets it for its hooks, which turbo never runs
    envFile = process.env.CLAUDE_ENV_FILE,
  } = {},
): Promise<Record<string, unknown>> {
  if (envFile) {
    appendFileSync(envFile, `export PATH='${BIN.replaceAll("'", "'\\''")}':"$PATH"\n`);
  }
  const parts = [
    `Local environment check (bun run doctor):\n${await summary(doctor, cache)}`,
    "If it lists a problem that matters for the user's task, say so and suggest the fix it names. Don't run `bun run setup` or start services on your own for a task that doesn't need them.",
  ];
  if (input.source === "compact") {
    const files = await changed();
    if (files.length) {
      parts.push(
        `The conversation was just compacted. The working tree changes these files:\n${files.slice(0, 50).join("\n")}${files.length > 50 ? `\n(and ${files.length - 50} more)` : ""}`,
      );
    }
  }
  return {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n") },
  };
}

await runMain(import.meta, hookMain(sessionStart));
