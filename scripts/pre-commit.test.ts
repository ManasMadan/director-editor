import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { preCommit, STEPS, stagedFiles, start } from "./pre-commit";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

/** A stand-in for `start`: records each command, and answers when told to. */
function steps(fails: string[] = []) {
  const started: string[] = [];
  const pending: (() => void)[] = [];
  let running = 0;
  let most = 0;
  const run = (command: string[]) => {
    const line = command.join(" ");
    started.push(line);
    running++;
    most = Math.max(most, running);
    return new Promise<{ status: number; output: string }>((resolve) => {
      pending.push(() => {
        running--;
        resolve({ status: fails.includes(line) ? 1 : 0, output: `output of ${line}\n` });
      });
    });
  };
  /** Finishes the oldest running step. */
  const finishOne = async () => {
    pending.shift()?.();
    await Bun.sleep(0);
  };
  /** Finishes every step started so far, oldest first, until none is left. */
  const finish = async () => {
    for (let next = pending.shift(); next; next = pending.shift()) {
      next();
      await Bun.sleep(0);
    }
  };
  return { run, started, finish, finishOne, most: () => most };
}

const LINT = "bunx lint-staged";
const SECRETS = "bun scripts/secret-scan.ts";
const TRIVY = "bun scripts/misconfig.ts";
const OSV = "bun scripts/osv.ts";

describe("the pre-commit checks", () => {
  it("runs the scans only for staged files they read, all at once when there are cores", async () => {
    captureOutput();
    const app = steps();
    const done = preCommit({ staged: ["apps/api/src/main.ts"], run: app.run, slots: 8 });
    await app.finish();
    expect(await done).toBe(0);
    expect(app.started).toEqual([LINT, SECRETS]);

    const infra = steps();
    const staged = ["deploy/docker/web.Dockerfile", "deploy/charts/stack/values.yaml", "bun.lock"];
    const all = preCommit({ staged, run: infra.run, slots: 8 });
    await infra.finish();
    expect(await all).toBe(0);
    expect(infra.started).toEqual([LINT, SECRETS, TRIVY, OSV, "bun scripts/linters.ts hadolint"]);
    expect(infra.most()).toBe(4);
  });

  // lint-staged hides and restores the unstaged changes around its fixes: a scan reading
  // the tree meanwhile finds files missing (.env.example, .trivyignore.yaml) and fails.
  it("starts nothing else while lint-staged runs, then the scans together", async () => {
    captureOutput();
    const { run, started, finishOne } = steps();
    const done = preCommit({ staged: ["bun.lock", "trivy.yaml"], run, slots: 8 });
    await Bun.sleep(5);
    expect(started).toEqual([LINT]);
    await finishOne();
    await Bun.sleep(5);
    expect(started).toEqual([LINT, SECRETS, TRIVY, OSV]);
    await finishOne();
    await finishOne();
    await finishOne();
    expect(await done).toBe(0);
  });

  it("lints a staged workflow with actionlint and zizmor", async () => {
    captureOutput();
    const { run, started, finish } = steps();
    const done = preCommit({ staged: [".github/workflows/ci.yml"], run, slots: 8 });
    await finish();
    expect(await done).toBe(0);
    expect(started).toEqual([
      LINT,
      SECRETS,
      "bun scripts/linters.ts actionlint",
      "bun scripts/linters.ts zizmor",
    ]);
  });

  it("lints a staged shell script, Dockerfile, OpenTofu file and Renovate's config", async () => {
    captureOutput();
    const { run, started, finish } = steps();
    const staged = [
      ".husky/pre-commit",
      ".devcontainer/Dockerfile",
      "infra/tofu/envs/k3s/main.tf",
      "renovate.json5",
    ];
    const done = preCommit({ staged, run, slots: 8 });
    await finish();
    expect(await done).toBe(0);
    expect(started.filter((line) => line.startsWith("bun scripts/linters.ts"))).toEqual([
      "bun scripts/linters.ts shellcheck",
      "bun scripts/linters.ts hadolint",
      "bun scripts/linters.ts tflint",
      "bun scripts/linters.ts renovate",
    ]);
  });

  it("runs no more at once than it has slots", async () => {
    captureOutput();
    const { run, finish, most } = steps();
    const done = preCommit({ staged: ["bun.lock", "trivy.yaml"], run, slots: 2 });
    await finish();
    expect(await done).toBe(0);
    expect(most()).toBe(2);
  });

  it("prints a failed step's output and starts nothing after it", async () => {
    const printed = captureOutput();
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const { run, started, finish } = steps([LINT]);
    const done = preCommit({ staged: ["bun.lock"], run, slots: 1 });
    await finish();
    expect(await done).toBe(1);
    expect(started).toEqual([LINT]);
    expect(stdout).toHaveBeenCalledWith(`output of ${LINT}\n`);
    expect(printed()).toContain("lint-staged failed");
  });

  it("keeps a passing step's output to itself", async () => {
    const printed = captureOutput();
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const { run, finish } = steps();
    const done = preCommit({ staged: [], run, slots: 1 });
    await finish();
    expect(await done).toBe(0);
    expect(stdout).not.toHaveBeenCalled();
    expect(printed()).toMatch(/lint-staged \(\d+\.\ds\)/);
  });

  it("names each step, and starts lint-staged first", () => {
    expect(STEPS[0]?.command).toEqual(["bunx", "lint-staged"]);
    expect(new Set(STEPS.map((step) => step.name)).size).toBe(STEPS.length);
  });

  it("reads the staged paths from git", () => {
    const { run, calls } = fakeRun(() => ({ stdout: "a.ts\0deploy/x.yaml\0" }));
    expect(stagedFiles(run)).toEqual(["a.ts", "deploy/x.yaml"]);
    expect(calls).toEqual(["git diff --cached --name-only -z"]);
  });
});

describe("starting a step", () => {
  it("returns its status and its output, both streams", async () => {
    const script = "console.log('out'); console.error('err'); process.exit(3)";
    const { status, output } = await start([process.execPath, "-e", script]);
    expect(status).toBe(3);
    expect(output).toContain("out\n");
    expect(output).toContain("err\n");
  });

  it("has no status for a command that doesn't exist", async () => {
    const { status, output } = await start(["no-such-command-for-the-hook"]);
    expect(status).toBeNull();
    expect(output).toContain("no-such-command-for-the-hook");
  });
});
