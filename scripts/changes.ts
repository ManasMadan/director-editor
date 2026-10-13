/**
 * What a pull request changes, by the CI jobs that need to run for it: CI's `changes`
 * job runs `bun scripts/changes.ts HEAD^1` on the pull request's merge commit (its first
 * parent is the base branch) and gates the heavy jobs on its answer, so a
 * docs-only pull request doesn't spend an hour of runners, and a chart-only one (a
 * production promotion, a rollback) skips the app's test suites.
 *
 *   app      the application and its tests: type-check, unit, components, integration,
 *            e2e, Python, codegen, migrations, generators, API compatibility, images
 *   charts   deploy/ and what checks it (charts:check)
 *   infra    infra/tofu and what checks it (infra:check)
 *   images   the Dockerfiles and the images' smoke test, besides the app itself
 *   scripts  scripts/ and the Claude Code hooks, whose tests read all of the above, and
 *            the docs: some of those tests read a doc by name (docs/environment.md,
 *            docs/deploy.md, docs/repository-settings.md, docs/testing.md's exceptions)
 *            and one reads every tracked file (rename's), so no doc is reading matter only
 *
 * A change to CI itself, the toolchain or the lockfile runs everything. Outside pull
 * requests (master, the merge queue, nightly) CI runs everything without asking.
 * Prints `name=true|false` lines for $GITHUB_OUTPUT.
 */
import { ROOT, type Run, runMain, runSync } from "./lib";

export type Area = "app" | "charts" | "infra" | "images" | "scripts";
const AREAS: Area[] = ["app", "charts", "infra", "images", "scripts"];

/** Files that change how every job runs. */
const EVERYTHING = [
  /^\.github\//,
  /^package\.json$/,
  /^bun\.lock$/,
  /^turbo\.json$/,
  /^\.nvmrc$/,
  /^scripts\/(changes|lib)\.ts$/,
];

/** The areas one changed file touches. */
export function areasOf(file: string): Area[] {
  if (EVERYTHING.some((pattern) => pattern.test(file))) {
    return AREAS;
  }
  if (file.startsWith(".claude/") || /\.md$/.test(file) || file === "LICENSE") {
    return ["scripts"];
  }
  if (file === "deploy/docker/check-peers.mjs") {
    // Its tests are the scripts' (scripts/check-peers.test.ts).
    return ["images", "scripts"];
  }
  if (file.startsWith("deploy/docker/") || file === "docker-bake.hcl") {
    return ["images"];
  }
  if (
    ["deploy/argocd/root.yaml", "deploy/argocd/argo-cd-values.yaml"].includes(file) ||
    file === "infra/tofu/modules/bootstrap/variables.tf"
  ) {
    // The bootstrap reads these, and charts:check renders Argo CD at the bootstrap's pin.
    return ["charts", "infra", "scripts"];
  }
  if (file.startsWith("deploy/") || file === ".sops.yaml") {
    return ["charts", "scripts"];
  }
  if (file.startsWith("infra/tofu/")) {
    return ["infra", "scripts"];
  }
  if (/^scripts\/(charts|secrets-check)\.ts$/.test(file)) {
    return ["charts", "scripts"];
  }
  if (file === "scripts/infra.ts") {
    return ["infra", "scripts"];
  }
  if (file === "scripts/image-smoke.ts") {
    return ["images", "scripts"];
  }
  if (file.startsWith("scripts/")) {
    return ["scripts"];
  }
  return ["app"];
}

/** Every area and whether the files touch it. */
export function areas(files: string[]): Record<Area, boolean> {
  const touched = new Set(files.flatMap(areasOf));
  return {
    app: touched.has("app"),
    charts: touched.has("charts"),
    infra: touched.has("infra"),
    images: touched.has("images"),
    scripts: touched.has("scripts"),
  };
}

/**
 * The command: the areas changed since `base` (a pull request's base), or all of them
 * without one (a push, the merge queue, the nightly run), as `area=true` lines for
 * GITHUB_OUTPUT; the exit code.
 */
export function main(base = process.argv[2], run: Run = runSync): number {
  let files = [".github/"];
  if (base) {
    const diff = run("git", ["diff", "--name-only", base, "HEAD"], { cwd: ROOT });
    if (diff.status !== 0) {
      console.error(`git diff against ${base} failed: ${diff.stderr}`);
      return 1;
    }
    files = diff.stdout.split("\n").filter(Boolean);
  }
  const result = areas(files);
  for (const area of AREAS) {
    console.log(`${area}=${result[area]}`);
  }
  return 0;
}

await runMain(import.meta, main);
