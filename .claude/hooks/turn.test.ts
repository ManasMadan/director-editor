import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Check } from "./checks";
import { askedFile, type HookInput, ROOT, sessionFiles, stopCountFile, turnFile } from "./lib";
import { sessionEnd } from "./session-end";
import { turnStart } from "./turn-start";
import { runCheck, verifyTurn } from "./verify-turn";

const sessions: string[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) {
    for (const file of [turnFile(session), stopCountFile(session), askedFile(session)]) {
      rmSync(file, { force: true });
    }
  }
});

function turn(extra: Partial<HookInput> = {}): HookInput {
  const session_id = `test-${crypto.randomUUID()}`;
  sessions.push(session_id);
  return { session_id, hook_event_name: "Stop", cwd: ROOT, ...extra };
}

/** A check's result as runCheck gives it. */
const result = (check: Check, code: number, timedOut = false) => ({
  check,
  code,
  timedOut,
  log: `${check.label} said ${code}`,
});

describe("the session's end", () => {
  it("removes its turn state", () => {
    const input = turn({ hook_event_name: "SessionEnd" });
    for (const file of sessionFiles) {
      writeFileSync(file(input.session_id), "x");
    }
    expect(sessionEnd(input)).toBeUndefined();
    for (const file of sessionFiles) {
      expect(existsSync(file(input.session_id))).toBe(false);
    }
  });
});

describe("the turn's start", () => {
  it("records the tree and resets the re-check count", async () => {
    const input = turn();
    writeFileSync(stopCountFile(input.session_id), "2");
    expect(await turnStart(input, async () => "tree-1")).toBeUndefined();
    expect(readFileSync(turnFile(input.session_id), "utf8")).toBe("tree-1");
    expect(existsSync(stopCountFile(input.session_id))).toBe(false);
  });
});

describe("the turn's end", () => {
  const fingerprint = async () => "tree-2";

  it("checks nothing when the turn changed nothing", async () => {
    const input = turn();
    writeFileSync(turnFile(input.session_id), "tree-2");
    const changed = async () => {
      throw new Error("must not look");
    };
    expect(await verifyTurn(input, { fingerprint, changed })).toBeUndefined();
  });

  it("passes when the checks for what changed pass", async () => {
    const ran: string[] = [];
    const output = await verifyTurn(turn(), {
      fingerprint,
      changed: async () => ["apps/api/src/x.ts"],
      run: async (check) => {
        ran.push(check.label);
        return result(check, 0);
      },
    });
    expect(output).toBeUndefined();
    expect(ran).toContain("Biome on the changed files");
  });

  it("sends Claude back with the failing checks' output, and counts the re-check", async () => {
    const input = turn();
    writeFileSync(turnFile(input.session_id), "tree-1");
    writeFileSync(stopCountFile(input.session_id), "1");
    const output = await verifyTurn(input, {
      fingerprint,
      changed: async () => ["scripts/x.ts"],
      run: async (check) => result(check, check.label === "knip" ? 1 : 0),
    });
    expect(output).toEqual({
      decision: "block",
      reason: expect.stringContaining("## knip\nknip said 1"),
    });
    expect(readFileSync(stopCountFile(input.session_id), "utf8")).toBe("2");
    expect((output as { reason: string }).reason).not.toContain("bun run gen");
    const inPackage = await verifyTurn(turn(), {
      fingerprint,
      changed: async () => ["apps/api/src/x.ts"],
      run: async (check) => result(check, check.label === "knip" ? 1 : 0),
    });
    expect((inPackage as { reason: string }).reason).toContain("turbo ran `bun run gen` first");
  });

  it("stops after three re-checks and tells the user", async () => {
    const input = turn({ stop_hook_active: true });
    writeFileSync(stopCountFile(input.session_id), "3");
    expect(await verifyTurn(input, { fingerprint })).toEqual({
      systemMessage: expect.stringContaining("still fail after 3 fixes"),
    });
  });

  it("asks for the checks that ran out of time, once for the same tree", async () => {
    const input = turn();
    const given = {
      fingerprint,
      changed: async () => ["docs/x.md", "apps/api/src/x.ts"],
      // turbo runs out of time: its exit code then isn't a failure.
      run: async (check: Check) => {
        const slow = check.command.includes("turbo");
        return result(check, slow ? 1 : 0, slow);
      },
    };
    expect(await verifyTurn(input, given)).toEqual({
      decision: "block",
      reason: expect.stringContaining("Run `bunx turbo run lint"),
    });
    expect(readFileSync(askedFile(input.session_id), "utf8")).toBe("tree-2");
    expect(await verifyTurn(input, given)).toBeUndefined();
  });

  it("asks for the full checks when the change touches what every package depends on", async () => {
    const output = await verifyTurn(turn(), {
      fingerprint,
      changed: async () => ["bun.lock"],
      budgetMs: 5000,
    });
    expect(output).toEqual({
      decision: "block",
      reason: expect.stringContaining(
        "couldn't cover this change in 5 s (it touches what every package depends on). Run `bun run check-types` and `bun run test`",
      ),
    });
  });
});

describe("running a check", () => {
  it("returns its exit code and output", async () => {
    const check = {
      label: "x",
      command: ["bun", "-e", "console.log('out'); console.error('err'); process.exit(3)"],
    };
    expect(await runCheck(check, AbortSignal.timeout(30_000))).toEqual({
      check,
      code: 3,
      timedOut: false,
      log: "out\n\nerr",
    });
  });

  it("stops one that runs past the deadline, and says so", async () => {
    const check = { label: "slow", command: ["bun", "-e", "setTimeout(() => {}, 30_000)"] };
    expect(await runCheck(check, AbortSignal.timeout(100))).toMatchObject({ timedOut: true });
  });
});
