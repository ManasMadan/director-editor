/**
 * Releases are tags pushed by hand; production moves when its promotion pull request
 * is merged (docs/deploy.md, "Releases → production"):
 *
 *   git tag v1.4.0 && git push origin v1.4.0   release.yml checks the tag and publishes
 *                                              the GitHub release with these notes
 *   bun run promote v1.4.0                     opens production's promotion pull request
 *                                              from your own GitHub login, so CI runs on it
 *
 * `check` and `notes` are what release.yml runs; they work locally too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { HOUR_MS } from "../packages/contracts/src/time";
import { fail, ok, ROOT, type Run, runMain, runSync } from "./lib";

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MOBILE_CONFIG = "apps/mobile/app.config.ts";
const PRODUCTION = "deploy/environments/production/release.yaml";
const STAGING = "deploy/environments/staging/stack.yaml";
/** How long release.yml waits for CI and deploy.yml to finish on the tagged commit. */
const DEPLOY_WAIT_MS = HOUR_MS;

/**
 * The sections of the notes, in order; other types (chore, docs, test, …) are left out.
 * Written here rather than with git-cliff or GitHub's generated notes: breaking changes
 * come first, from the `!` or the BREAKING CHANGE footer, which is how the API
 * compatibility check tells a major release apart (ci.yml, api-compat).
 */
const SECTIONS: [type: string, title: string][] = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["revert", "Reverts"],
  ["build", "Build and infrastructure"],
];

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

export interface Commit {
  hash: string;
  subject: string;
  body: string;
}

/** Markdown release notes from the commits since the last release, newest first. */
export function releaseNotes(commits: Commit[]): string {
  const breaking: string[] = [];
  const sections = new Map<string, string[]>(SECTIONS.map(([type]) => [type, []]));
  for (const commit of commits) {
    const match = CONVENTIONAL.exec(commit.subject)?.groups;
    if (!match?.type || !match.subject) {
      continue;
    }
    const scope = match.scope ? `**${match.scope}:** ` : "";
    const line = `- ${scope}${match.subject} (${commit.hash})`;
    if (match.breaking || /^BREAKING[ -]CHANGE: /m.test(commit.body)) {
      breaking.push(line);
    }
    sections.get(match.type)?.push(line);
  }
  const parts: string[] = [];
  if (breaking.length) {
    parts.push(`## Breaking changes\n\n${breaking.join("\n")}`);
  }
  for (const [type, title] of SECTIONS) {
    const lines = sections.get(type) ?? [];
    if (lines.length) {
      parts.push(`## ${title}\n\n${lines.join("\n")}`);
    }
  }
  return parts.length ? `${parts.join("\n\n")}\n` : "Maintenance only: no user-facing changes.\n";
}

/** The app version in the mobile config, which store builds of a release carry. */
export function mobileVersion(config: string): string | undefined {
  return /^\s*version:\s*"([^"]+)"/m.exec(config)?.[1];
}

/**
 * Production's release.yaml pointed at a release: Argo CD reads its charts, values and
 * Secrets at the tag, and runs its images. The file's comments are kept.
 */
export function releaseFile(current: string, tag: string, imageTag: string): string {
  const comments = current.split("\n").filter((line) => line.startsWith("#"));
  return [...comments, `revision: ${tag}`, `imageTag: ${imageTag}`, ""].join("\n");
}

/** What finding a release's images needs from git and CI (injected, so it's testable). */
export interface ReleaseFacts {
  /** Whether deploy.yml passed for the commit: its images are built, signed and deployed. */
  deployed(commit: string): boolean;
  /** The files the commit changes against its parent. */
  changedFiles(commit: string): string[];
  parent(commit: string): string;
  /** `image.tag` in staging's values at the commit. */
  stagingTag(commit: string): string | undefined;
}

/**
 * The image tag a release of `commit` ships, or undefined when there are no images for it.
 * A commit deploy.yml passed for has its own. Tagging master's head usually tags the
 * staging bump deploy.yml commits afterwards (`[skip ci]`, so no images of its own); it
 * only repoints staging at its parent's images, so a release of it ships those: the same
 * code.
 */
export function releaseImageTag(commit: string, facts: ReleaseFacts): string | undefined {
  if (facts.deployed(commit)) {
    return `sha-${commit}`;
  }
  const parent = facts.parent(commit);
  const staging = facts.changedFiles(commit);
  const bump =
    staging.length === 1 && staging[0] === STAGING && facts.stagingTag(commit) === `sha-${parent}`;
  return bump && facts.deployed(parent) ? `sha-${parent}` : undefined;
}

/** What the release commands touch; the tests replace them. */
export interface Tools {
  run: Run;
  /** The checkout the commands run in (production's release.yaml is written there). */
  root: string;
  sleep: (ms: number) => Promise<unknown>;
  /** Where `notes` prints the notes. */
  write: (text: string) => unknown;
}

const REAL: Tools = {
  run: runSync,
  root: ROOT,
  sleep: Bun.sleep,
  write: process.stdout.write.bind(process.stdout),
};

const workflowRuns = z.array(
  z.object({ workflowName: z.string(), status: z.string(), conclusion: z.string() }),
);
const stagingValues = z.object({ image: z.object({ tag: z.unknown() }).optional() });

/** git and gh in the checkout, and the facts about a release they answer. */
function helpers({ run, root }: Tools) {
  const command = (name: string) => (args: string[]) => {
    const result = run(name, args, { cwd: root });
    if (result.status !== 0) {
      throw new Error(`${name} ${args.join(" ")}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  };
  const git = command("git");
  const gh = command("gh");
  const runsOf = (commit: string) =>
    workflowRuns.parse(
      JSON.parse(
        gh(["run", "list", "--commit", commit, "--json", "workflowName,status,conclusion"]),
      ),
    );
  const facts: ReleaseFacts = {
    deployed: (commit) =>
      runsOf(commit).some((run) => run.workflowName === "Deploy" && run.conclusion === "success"),
    changedFiles: (commit) =>
      git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).split("\n").filter(Boolean),
    parent: (commit) => git(["rev-parse", `${commit}^`]),
    stagingTag: (commit) => {
      const values = stagingValues.parse(Bun.YAML.parse(git(["show", `${commit}:${STAGING}`])));
      return typeof values.image?.tag === "string" ? values.image.tag : undefined;
    },
  };
  return { run, root, git, gh, runsOf, facts };
}
type Helpers = ReturnType<typeof helpers>;

/** Waits while CI or deploy.yml is still running on the commit (a tag pushed right after a merge). */
async function settled({ runsOf }: Helpers, sleep: Tools["sleep"], commit: string) {
  const deadline = Date.now() + DEPLOY_WAIT_MS;
  for (;;) {
    const busy = runsOf(commit).filter(
      (run) => ["CI", "Deploy"].includes(run.workflowName) && run.status !== "completed",
    );
    if (busy.length === 0 || Date.now() > deadline) {
      return;
    }
    console.log(
      `  waiting for ${busy.map((run) => run.workflowName).join(" and ")} on ${commit.slice(0, 7)}`,
    );
    await sleep(30_000);
  }
}

const noImages = (tag: string, commit: string) =>
  `${tag} (${commit.slice(0, 7)}) has no images: deploy.yml hasn't passed for it. ` +
  "Tag a commit that deployed (the merge, or the staging bump right after it).";

function commitsSince({ run, root, git }: Helpers, tag: string): Commit[] {
  // The previous release, if there is one: every commit before it is in an older release.
  const previous = run("git", ["describe", "--tags", "--abbrev=0", "--match=v*", `${tag}^`], {
    cwd: root,
  });
  const range = previous.status === 0 ? `${previous.stdout.trim()}..${tag}` : tag;
  const log = git(["log", "--no-merges", "--format=%h%x1f%s%x1f%b%x1e", range]);
  return log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash = "", subject = "", body = ""] = entry.split("\x1f");
      return { hash, subject, body };
    });
}

/**
 * A release tag must be a version, on master, have images (a commit deploy.yml passed for,
 * or the staging bump right after one), and match the mobile app's version; the exit code.
 */
async function check(tools: Helpers, sleep: Tools["sleep"], tag: string) {
  const { run, root, git, facts } = tools;
  const problems: string[] = [];
  if (!TAG.test(tag)) {
    problems.push(`${tag} isn't a version tag like v1.4.0`);
  }
  const commit = git(["rev-list", "-n", "1", tag]);
  const ancestor = run("git", ["merge-base", "--is-ancestor", commit, "origin/master"], {
    cwd: root,
  });
  const onMaster = ancestor.status === 0;
  if (!onMaster) {
    problems.push(`${tag} (${commit.slice(0, 7)}) isn't on master`);
  }
  await settled(tools, sleep, commit);
  const images = releaseImageTag(commit, facts);
  if (!images) {
    problems.push(noImages(tag, commit));
  }
  const version = mobileVersion(git(["show", `${tag}:${MOBILE_CONFIG}`]));
  if (version !== tag.slice(1)) {
    problems.push(
      `${MOBILE_CONFIG} says version ${version ?? "(none)"}: set it to ${tag.slice(1)} on master ` +
        "first (store builds of this release carry it), then tag that commit",
    );
  }
  for (const problem of problems) {
    fail(problem);
  }
  if (problems.length) {
    return 1;
  }
  ok(`${tag} is a release of ${commit.slice(0, 7)}, with the images ${images}`);
  return 0;
}

/** Opens production's promotion pull request for a release, as whoever runs it; the exit code. */
function promote({ root, git, gh, facts }: Helpers, tag: string) {
  git(["fetch", "--quiet", "--tags", "origin", "master"]);
  const commit = git(["rev-list", "-n", "1", tag]);
  const imageTag = releaseImageTag(commit, facts);
  if (!imageTag) {
    fail(noImages(tag, commit));
    return 1;
  }
  const branch = `release/production-${tag}`;
  const title = `chore(infra): deploy ${tag} to production`;
  const file = join(root, PRODUCTION);
  const from = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  git(["switch", "--quiet", "-c", branch, "origin/master"]);
  writeFileSync(file, releaseFile(readFileSync(file, "utf8"), tag, imageTag));
  git(["commit", "--quiet", "-m", title, "--", PRODUCTION]);
  git(["push", "--quiet", "-u", "origin", branch]);
  git(["switch", "--quiet", from]);
  const url = gh([
    "pr",
    "create",
    "--base",
    "master",
    "--head",
    branch,
    "--title",
    title,
    "--body",
    `Points production at ${tag}: its charts, values and Secrets, and its images (\`${imageTag}\`), already running on staging. Merging deploys it.`,
  ]);
  ok(`Promotion pull request: ${url}`);
  return 0;
}

/** `check`, `notes` or `promote` a tag; the exit code. */
export async function release(argv = process.argv.slice(2), given: Partial<Tools> = {}) {
  const tools = { ...REAL, ...given };
  const [command, tag] = argv;
  if (!tag || !["check", "notes", "promote"].includes(command ?? "")) {
    console.error("usage: bun scripts/release.ts check|notes|promote v<major>.<minor>.<patch>");
    return 1;
  }
  const commands = helpers(tools);
  if (command === "check") {
    return check(commands, tools.sleep, tag);
  }
  if (command === "notes") {
    tools.write(releaseNotes(commitsSince(commands, tag)));
    return 0;
  }
  return promote(commands, tag);
}

await runMain(import.meta, release);
