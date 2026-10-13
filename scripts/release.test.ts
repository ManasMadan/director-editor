import { afterEach, describe, expect, it, mock } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "./lib";
import {
  mobileVersion,
  type ReleaseFacts,
  release,
  releaseFile,
  releaseImageTag,
  releaseNotes,
} from "./release";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const commit = (subject: string, body = "") => ({ hash: "abc1234", subject, body });

describe("release notes", () => {
  it("groups user-facing commits by type and leaves the rest out", () => {
    const notes = releaseNotes([
      commit("feat(api): share todos"),
      commit("fix: keep the session on refresh"),
      commit("chore(deps): bump zod"),
      commit("docs: explain releases"),
      commit("perf(web): smaller sign-in page"),
      commit("not conventional at all"),
    ]);
    expect(notes).toBe(
      [
        "## Features\n\n- **api:** share todos (abc1234)",
        "## Fixes\n\n- keep the session on refresh (abc1234)",
        "## Performance\n\n- **web:** smaller sign-in page (abc1234)\n",
      ].join("\n\n"),
    );
  });

  it("lists breaking changes first, from `!` or a BREAKING CHANGE footer", () => {
    const notes = releaseNotes([
      commit("feat(api)!: drop v0 routes"),
      commit("fix(auth): shorter sessions", "Details.\n\nBREAKING CHANGE: sessions last a day"),
    ]);
    expect(notes.startsWith("## Breaking changes\n\n- **api:** drop v0 routes")).toBe(true);
    expect(notes).toContain("- **auth:** shorter sessions (abc1234)\n\n## Features");
  });

  it("says so when nothing user-facing changed", () => {
    expect(releaseNotes([commit("chore: tidy")])).toBe(
      "Maintenance only: no user-facing changes.\n",
    );
  });
});

describe("the mobile version", () => {
  it("is read from the app config", () => {
    expect(mobileVersion('export default {\n  name: "App",\n  version: "1.4.0",\n}')).toBe("1.4.0");
    expect(mobileVersion("export default {}")).toBeUndefined();
  });
});

describe("promoting", () => {
  it("pins production to the release's revision and images, keeping the comments", () => {
    const current = "# The release production runs.\n# Written by promote.\nrevision: HEAD\n";
    expect(releaseFile(current, "v1.4.0", "sha-123")).toBe(
      "# The release production runs.\n# Written by promote.\nrevision: v1.4.0\nimageTag: sha-123\n",
    );
  });

  it("writes what the envs ApplicationSet reads", () => {
    const release = Bun.YAML.parse(releaseFile("revision: v1.0.0\n", "v1.4.0", "sha-1")) as object;
    expect(release).toEqual({ revision: "v1.4.0", imageTag: "sha-1" });
  });
});

describe("a release's images", () => {
  const STAGING = "deploy/environments/staging/stack.yaml";
  // master: merge (deployed) ← bump ([skip ci], repoints staging at the merge's images).
  const facts = (overrides: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
    deployed: (commit) => commit === "merge",
    changedFiles: (commit) => (commit === "bump" ? [STAGING] : ["apps/api/src/main.ts"]),
    parent: (commit) => (commit === "bump" ? "merge" : "older"),
    stagingTag: (commit) => (commit === "bump" ? "sha-merge" : "sha-older"),
    ...overrides,
  });

  it("are the commit's own once deploy.yml passed for it", () => {
    expect(releaseImageTag("merge", facts())).toBe("sha-merge");
  });

  it("are the parent's for the staging bump right after it", () => {
    expect(releaseImageTag("bump", facts())).toBe("sha-merge");
  });

  it("don't exist for a commit that never deployed", () => {
    expect(releaseImageTag("older", facts())).toBeUndefined();
  });

  it("aren't borrowed by a bump that changes anything else, or points elsewhere", () => {
    expect(
      releaseImageTag("bump", facts({ changedFiles: () => [STAGING, "apps/api/src/main.ts"] })),
    ).toBeUndefined();
    expect(releaseImageTag("bump", facts({ stagingTag: () => "sha-older" }))).toBeUndefined();
    expect(releaseImageTag("bump", facts({ deployed: () => false }))).toBeUndefined();
  });
});

describe("the release command", () => {
  const ROOT = join(import.meta.dir, "..");
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
  const MOBILE = read("apps/mobile/app.config.ts");
  const VERSION = `v${mobileVersion(MOBILE)}`;
  const STAGING = read("deploy/environments/staging/stack.yaml");
  const MERGE = "1111111aaaaaaa";
  const BUMP = "2222222bbbbbbb";
  const runs = (...list: [string, string, string][]) => ({
    stdout: JSON.stringify(
      list.map(([workflowName, status, conclusion]) => ({ workflowName, status, conclusion })),
    ),
  });
  const deployed = runs(["CI", "completed", "success"], ["Deploy", "completed", "success"]);

  /** A repository whose tag points at `commit`: the merge (deployed) or the staging bump after it. */
  const repo = (commit: string, overrides: Record<string, Partial<Ran>> = {}) =>
    fakeRun(
      (line) =>
        overrides[line] ??
        {
          [`git rev-list -n 1 ${VERSION}`]: { stdout: `${commit}\n` },
          [`git show ${VERSION}:apps/mobile/app.config.ts`]: { stdout: MOBILE },
          [`gh run list --commit ${MERGE} --json workflowName,status,conclusion`]: deployed,
          [`gh run list --commit ${BUMP} --json workflowName,status,conclusion`]: runs(),
          [`git rev-parse ${BUMP}^`]: { stdout: `${MERGE}\n` },
          [`git diff-tree --no-commit-id --name-only -r ${BUMP}`]: {
            stdout: "deploy/environments/staging/stack.yaml\n",
          },
          [`git show ${BUMP}:deploy/environments/staging/stack.yaml`]: {
            stdout: STAGING.replace('tag: ""', `tag: "sha-${MERGE}"`),
          },
          "git rev-parse --abbrev-ref HEAD": { stdout: "my-branch\n" },
          [`gh pr create --base master --head release/production-${VERSION} --title chore(infra): deploy ${VERSION} to production --body Points production at ${VERSION}: its charts, values and Secrets, and its images (\`sha-${MERGE}\`), already running on staging. Merging deploys it.`]:
            { stdout: "https://github.com/o/r/pull/7\n" },
        }[line],
    );
  const noSleep = { sleep: async () => undefined };

  it("says how to call it", async () => {
    const printed = captureOutput();
    expect(await release([])).toBe(1);
    expect(await release(["ship", VERSION])).toBe(1);
    expect(printed()).toContain("usage: bun scripts/release.ts check|notes|promote");
  });

  it("checks a tag of a deployed commit on master, in the checkout", async () => {
    const printed = captureOutput();
    const { run, calls, options } = repo(MERGE);
    expect(await release(["check", VERSION], { run, root: "/repo", ...noSleep })).toBe(0);
    expect(calls).toEqual([
      `git rev-list -n 1 ${VERSION}`,
      `git merge-base --is-ancestor ${MERGE} origin/master`,
      `gh run list --commit ${MERGE} --json workflowName,status,conclusion`,
      `gh run list --commit ${MERGE} --json workflowName,status,conclusion`,
      `git show ${VERSION}:apps/mobile/app.config.ts`,
    ]);
    expect(options.every((o) => o.cwd === "/repo")).toBe(true);
    expect(printed()).toContain(`${VERSION} is a release of 1111111, with the images sha-${MERGE}`);
  });

  it("waits for CI and deploy.yml to finish on the tagged commit", async () => {
    const printed = captureOutput();
    const answers = [
      runs(["CI", "in_progress", ""], ["Deploy", "queued", ""], ["Lint", "in_progress", ""]),
      runs(["CI", "completed", "success"], ["Deploy", "in_progress", ""]),
      deployed,
    ];
    const sleeps: number[] = [];
    const gh = `gh run list --commit ${MERGE} --json workflowName,status,conclusion`;
    const { run } = repo(MERGE);
    const code = await release(["check", VERSION], {
      run: (command, args, given) => {
        const ran = run(command, args, given);
        return [command, ...args].join(" ") === gh ? { ...ran, ...answers.shift() } : ran;
      },
      sleep: async (ms) => sleeps.push(ms),
    });
    expect(code).toBe(0);
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(printed()).toContain("waiting for CI and Deploy on 1111111");
    expect(printed()).toContain("waiting for Deploy on 1111111");
  });

  it("gives the staging bump after a merge the merge's images", async () => {
    const printed = captureOutput();
    expect(await release(["check", VERSION], { run: repo(BUMP).run, ...noSleep })).toBe(0);
    expect(printed()).toContain(`with the images sha-${MERGE}`);
  });

  it("lists every problem with a tag", async () => {
    const printed = captureOutput();
    const { run } = repo(MERGE, {
      "git rev-list -n 1 1.4": { stdout: `${MERGE}\n` },
      [`git merge-base --is-ancestor ${MERGE} origin/master`]: { status: 1 },
      [`gh run list --commit ${MERGE} --json workflowName,status,conclusion`]: runs([
        "Deploy",
        "completed",
        "failure",
      ]),
      "git show 1.4:apps/mobile/app.config.ts": { stdout: "export default {}" },
    });
    expect(await release(["check", "1.4"], { run, ...noSleep })).toBe(1);
    expect(printed()).toContain("1.4 isn't a version tag like v1.4.0");
    expect(printed()).toContain("1.4 (1111111) isn't on master");
    expect(printed()).toContain("1.4 (1111111) has no images: deploy.yml hasn't passed for it.");
    expect(printed()).toContain("apps/mobile/app.config.ts says version (none): set it to .4");
    expect(printed()).not.toContain("is a release of");
  });

  it("stops at a git command that fails, with git's error", async () => {
    const { run } = repo(MERGE, {
      [`git rev-list -n 1 ${VERSION}`]: { status: 128, stderr: "fatal: bad revision\n" },
    });
    await expect(release(["check", VERSION], { run, ...noSleep })).rejects.toThrow(
      `git rev-list -n 1 ${VERSION}: fatal: bad revision`,
    );
  });

  it("prints the notes since the previous release", async () => {
    const log = {
      stdout: "abc1234\x1ffeat(api): share todos\x1f\x1e\ndef5678\x1fchore: tidy\x1fbody\n\x1e\n",
    };
    const written: string[] = [];
    const { run, calls } = repo(MERGE, {
      "git describe --tags --abbrev=0 --match=v* v1.4.0^": { stdout: "v1.3.0\n" },
      "git log --no-merges --format=%h%x1f%s%x1f%b%x1e v1.3.0..v1.4.0": log,
    });
    const write = (text: string) => written.push(text);
    expect(await release(["notes", "v1.4.0"], { run, write })).toBe(0);
    expect(calls.at(-1)).toBe("git log --no-merges --format=%h%x1f%s%x1f%b%x1e v1.3.0..v1.4.0");
    expect(written).toEqual(["## Features\n\n- **api:** share todos (abc1234)\n"]);
  });

  it("prints every commit's notes for the first release", async () => {
    const written: string[] = [];
    const { run, calls } = repo(MERGE, {
      "git describe --tags --abbrev=0 --match=v* v0.1.0^": { status: 128 },
    });
    const write = (text: string) => written.push(text);
    expect(await release(["notes", "v0.1.0"], { run, write })).toBe(0);
    expect(calls.at(-1)).toBe("git log --no-merges --format=%h%x1f%s%x1f%b%x1e v0.1.0");
    expect(written).toEqual(["Maintenance only: no user-facing changes.\n"]);
  });

  it("opens production's promotion pull request from a branch of its own", async () => {
    const printed = captureOutput();
    const root = mkdtempSync(join(tmpdir(), "release-"));
    mkdirSync(join(root, "deploy/environments/production"), { recursive: true });
    const file = "deploy/environments/production/release.yaml";
    cpSync(join(ROOT, file), join(root, file));
    const { run, calls } = repo(BUMP);
    expect(await release(["promote", VERSION], { run, root })).toBe(0);
    const branch = `release/production-${VERSION}`;
    expect(calls.filter((line) => /^git (fetch|switch|commit|push)/.test(line))).toEqual([
      "git fetch --quiet --tags origin master",
      `git switch --quiet -c ${branch} origin/master`,
      `git commit --quiet -m chore(infra): deploy ${VERSION} to production -- ${file}`,
      `git push --quiet -u origin ${branch}`,
      "git switch --quiet my-branch",
    ]);
    expect(calls.at(-1)).toStartWith(`gh pr create --base master --head ${branch}`);
    expect(Bun.YAML.parse(readFileSync(join(root, file), "utf8"))).toEqual({
      revision: VERSION,
      imageTag: `sha-${MERGE}`,
    });
    expect(readFileSync(join(root, file), "utf8")).toStartWith("# The release production runs");
    expect(printed()).toContain("Promotion pull request: https://github.com/o/r/pull/7");
  });

  it("promotes nothing without images", async () => {
    const printed = captureOutput();
    const { run, calls } = repo(MERGE, {
      [`gh run list --commit ${MERGE} --json workflowName,status,conclusion`]: runs(),
      [`git rev-parse ${MERGE}^`]: { stdout: "0000000\n" },
    });
    expect(await release(["promote", VERSION], { run, root: "/nowhere" })).toBe(1);
    expect(calls.some((line) => line.startsWith("git switch"))).toBe(false);
    expect(printed()).toContain("has no images");
  });
});
