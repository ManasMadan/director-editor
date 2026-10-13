import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HookInput, ROOT } from "./lib";
import { runDoctor, sessionStart } from "./session-start";

/** `bun run doctor` as a stand-in answering `exitCode`, counting its runs. */
function doctor(exitCode: number | null = 0) {
  let runs = 0;
  const run = async () => {
    runs += 1;
    return { exitCode, stdout: "  \x1b[32m✔\x1b[0m Node v24\n" };
  };
  return { run, runs: () => runs };
}

const start = (source = "startup"): HookInput => ({
  session_id: "s",
  hook_event_name: "SessionStart",
  cwd: ROOT,
  source,
});
const cacheFile = () => join(mkdtempSync(join(tmpdir(), "session-")), "doctor.txt");
const context = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as { additionalContext: string }).additionalContext;

describe("the session's environment check", () => {
  it("runs the doctor and gives Claude its summary, without colours or a push to run setup", async () => {
    const cache = cacheFile();
    const { run, runs } = doctor();
    const text = context(await sessionStart(start(), { doctor: run, cache }));
    expect(runs()).toBe(1);
    expect(text).toContain("Local environment check (bun run doctor):\n  ✔ Node v24\n");
    expect(text).toContain("Don't run `bun run setup` or start services on your own");
    expect(readFileSync(cache, "utf8")).toBe("  ✔ Node v24\n");
  });

  it("reuses a clean summary for 10 minutes, then runs the doctor again", async () => {
    const cache = cacheFile();
    writeFileSync(cache, "cached\n");
    const { run, runs } = doctor();
    expect(context(await sessionStart(start(), { doctor: run, cache }))).toContain("cached");
    expect(runs()).toBe(0);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(cache, old, old);
    await sessionStart(start(), { doctor: run, cache });
    expect(runs()).toBe(1);
  });

  it("never caches a report with problems, so a fixed one isn't reported again", async () => {
    const cache = cacheFile();
    writeFileSync(cache, "stale\n");
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(cache, old, old);
    await sessionStart(start(), { doctor: doctor(1).run, cache });
    expect(existsSync(cache)).toBe(false);
  });

  it("says so when the doctor didn't finish", async () => {
    const cache = cacheFile();
    const text = context(await sessionStart(start(), { doctor: doctor(null).run, cache }));
    expect(text).toContain("didn't finish in 20 s");
    expect(existsSync(cache)).toBe(false);
  });

  it("lists the changed files after a compaction", async () => {
    const files = Array.from({ length: 52 }, (_, index) => `f${index}.ts`);
    const options = { doctor: doctor().run, cache: cacheFile(), changed: async () => files };
    const text = context(await sessionStart(start("compact"), options));
    expect(text).toContain("just compacted");
    expect(text).toContain("f49.ts\n(and 2 more)");
    expect(
      context(await sessionStart(start("compact"), { ...options, changed: async () => ["a.ts"] })),
    ).toContain("\na.ts");
    expect(
      context(await sessionStart(start("compact"), { ...options, changed: async () => [] })),
    ).not.toContain("compacted");
    expect(context(await sessionStart(start(), options))).not.toContain("compacted");
  });
});

describe("the shell's PATH", () => {
  it("has the playwright-cli command Playwright's official skill runs", async () => {
    const envFile = cacheFile();
    await sessionStart(start(), { doctor: doctor().run, cache: cacheFile(), envFile });
    const shell = Bun.spawnSync(
      ["sh", "-c", `. "${envFile}" && command -v playwright-cli && playwright-cli --version`],
      { cwd: ROOT },
    );
    expect(shell.stdout.toString()).toBe(
      `${join(ROOT, ".claude/bin/playwright-cli")}\n${
        (await Bun.file(join(ROOT, "node_modules/playwright-core/package.json")).json()).version
      }\n`,
    );
  });
});

describe("running the doctor", () => {
  it("returns its exit code and output, or null when it runs out of time", async () => {
    expect(await runDoctor(["sh", "-c", "echo ok; exit 3"])).toEqual({
      exitCode: 3,
      stdout: "ok\n",
    });
    expect((await runDoctor(["sleep", "5"], 50)).exitCode).toBeNull();
  });
});
