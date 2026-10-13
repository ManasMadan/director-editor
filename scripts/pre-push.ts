/**
 * The pre-push hook (`.husky/pre-push`): every check CI runs on a pull request that can run
 * on this machine, so a push that passes here passes CI. It finds what the push changes
 * (since the branch's upstream, or the default branch for a branch never pushed), sorts
 * the files into areas with scripts/changes.ts, the rules CI's `changes` job uses, and
 * runs each step exactly when CI would run its job, with the same commands.
 *
 *   bun scripts/pre-push.ts
 *   PRE_PUSH_CONCURRENCY=1 bun scripts/pre-push.ts      the cores the steps may share (1: one at a time)
 *   PRE_PUSH_MEMORY_GB=8 bun scripts/pre-push.ts        the memory the steps may share
 *   PRE_PUSH_SKIP=screenshots,e2e bun scripts/pre-push.ts   leave steps out (CI still runs them)
 *
 * Independent steps run side by side, as many as the machine's cores (less one) and memory
 * (less 2 GB) hold, by each step's rough needs; Docker's free memory limits the steps that
 * start containers.
 * The integration suites and the generators' check share Valkey's database numbers, so
 * they take turns. Each step's output is kept and shown when it fails; the first failure
 * stops every other step, and the summary names it. What CI checks that can't run here is
 * listed with the reason (CI_ONLY). It needs Docker: it starts the core services and RustFS.
 * `git push --no-verify` skips it all, leaving CI to decide.
 */
import { type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { testEnvironment } from "../packages/testing/src/environment";
import { type Clamd, clamdFor } from "../packages/testing/src/fake-clamd";
import { type Area, areas } from "./changes";
import { fail, ok, type Ran, ROOT, type Run, readEnv, runMain, runSync, warn } from "./lib";
import { dockerMemory } from "./services";
import { pushBase } from "./unit-coverage";

const GB = 1024 ** 3;

/** How a step runs a command: to the end, its output kept for the step's log unless `quiet`. */
export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; quiet?: boolean },
) => Promise<Ran>;

/** What every step is given. */
export interface Context {
  root: string;
  /** The commit the push starts from. */
  base: string;
  files: string[];
  areas: Record<Area, boolean>;
  /** A commit subject in the push that declares a breaking change (`feat(api)!: …`). */
  breaking: string | undefined;
  /** How many coverage suites run at once (turbo's --concurrency). */
  suites: number;
  /** The steps this run skips. */
  skipped: Set<string>;
  clamd: (url: string) => Promise<Clamd>;
  exec: Exec;
  log: (text: string) => void;
}

/** Runs a command; whether it passed. */
const passes = async (
  ctx: Context,
  command: string,
  args: string[],
  env?: Record<string, string>,
) => (await ctx.exec(command, args, { cwd: ctx.root, env })).status === 0;

export interface Step {
  name: string;
  /** The jobs it stands for, as `<workflow file>:<job>`. */
  jobs: string[];
  /** Runs when the push touches one of these areas, as CI's job does; always when empty. */
  areas: Area[];
  /** Why it's skipped even so, from the files the push changes. */
  skip?: (files: string[]) => string | undefined;
  needs?: string[];
  /** Steps in one lane run one at a time: the integration suites share Valkey's numbers. */
  lane?: string;
  /**
   * Left to finish when another step fails: an install, a generator or a scratch worktree
   * stopped half way leaves the checkout broken, or litters it, for the next run.
   */
  keep?: boolean;
  /** Roughly what it takes: cores (1 unless said), GB of the machine's memory and of Docker's. */
  cores?: number;
  memory: number;
  docker?: number;
  run: (ctx: Context) => Promise<boolean>;
}

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      env: z.record(z.string(), z.unknown()).optional(),
      steps: z.array(z.object({ with: z.record(z.string(), z.unknown()).optional() })).optional(),
    }),
  ),
});

/** A workflow in .github/workflows, its text and its jobs. */
export function workflow(name: string, root = ROOT) {
  const text = readFileSync(join(root, ".github/workflows", name), "utf8");
  return { text, ...workflowSchema.parse(Bun.YAML.parse(text)) };
}

/** A job's `env`, the plain values only (no `${{ … }}` expressions). */
export function jobEnv(file: string, job: string, root = ROOT): Record<string, string> {
  const env = workflow(file, root).jobs[job]?.env ?? {};
  return Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) =>
      typeof value === "string" && !value.includes("${{") ? [[key, value]] : [],
    ),
  );
}

/** The working tree's state: what's changed or untracked, and how. */
async function gitState(ctx: Context) {
  const status = await ctx.exec("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: ctx.root,
    quiet: true,
  });
  const diff = await ctx.exec("git", ["diff", "--no-ext-diff"], { cwd: ctx.root, quiet: true });
  return `${status.stdout}\n${diff.stdout}`;
}

/** CI's codegen job: `bun run gen`, then nothing changed or added. */
async function generatedCode(ctx: Context) {
  const before = await gitState(ctx);
  if (!(await passes(ctx, "bun", ["run", "gen"]))) {
    return false;
  }
  if ((await gitState(ctx)) === before) {
    return true;
  }
  await ctx.exec("git", ["status", "--short"], { cwd: ctx.root });
  ctx.log("Generated files are out of date: commit what `bun run gen` just wrote.\n");
  return false;
}

/** CI's api-compat job: oasdiff on both OpenAPI documents, then the domain events. */
async function apiCompatibility(ctx: Context) {
  const image = jobEnv("ci.yml", "api-compat", ctx.root).OASDIFF;
  if (ctx.breaking) {
    ctx.log(`"${ctx.breaking}" declares a breaking change: breaking changes are only reported.\n`);
  }
  const dir = mkdtempSync(join(tmpdir(), "api-compat-"));
  let passed = true;
  try {
    for (const app of ["api", "ai"]) {
      const path = `apps/${app}/openapi.json`;
      const base = await ctx.exec("git", ["show", `${ctx.base}:${path}`], {
        cwd: ctx.root,
        quiet: true,
      });
      if (base.status !== 0) {
        ctx.log(`The base has no ${path} yet.\n`);
        continue;
      }
      writeFileSync(join(dir, `${app}.json`), base.stdout);
      const mounts = ["-v", `${dir}:/base:ro`, "-v", `${join(ctx.root, "apps", app)}:/head:ro`];
      const oasdiff = ["breaking", `/base/${app}.json`, "/head/openapi.json"];
      const failOn = ctx.breaking ? [] : ["--fail-on", "ERR"];
      const run = ["run", "--rm", "--memory=256m", ...mounts, `${image}`, ...oasdiff, ...failOn];
      passed = (await passes(ctx, "docker", run)) && passed;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const events = await passes(ctx, "bun", ["scripts/events-compat.ts", ctx.base]);
  return passed && (events || ctx.breaking !== undefined);
}

/** CI's infra job, with the local tofu (CI installs the binary, not an image). */
async function infra(ctx: Context) {
  if ((await ctx.exec("tofu", ["version"], { cwd: ctx.root, quiet: true })).status !== 0) {
    ctx.log(
      "OpenTofu isn't installed: `brew install opentofu` (CI runs the version ci.yml pins).\n",
    );
    return false;
  }
  return passes(ctx, "bun", ["run", "infra:check"]);
}

/**
 * A database of its own, created the way infra/postgres/init creates `app` (as CI's jobs
 * get a fresh one) and migrated; dropped afterwards. `use` gets the environment pointing
 * every service's role at it.
 */
async function withDatabase(
  ctx: Context,
  label: string,
  use: (env: Record<string, string>, name: string) => Promise<boolean>,
) {
  const name = `prepush_${process.pid}_${label}`;
  const roles = "app_api, app_worker, app_notifications, app_webhooks, app_ai";
  const psql = (database: string, sql: string) =>
    passes(ctx, "docker", [
      ...["compose", "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", database],
      ...["-v", "ON_ERROR_STOP=1", "-c", sql],
    ]);
  const env = testEnvironment(join(ctx.root, ".env.example"));
  for (const key of Object.keys(env).filter((k) => /_DATABASE(_DIRECT)?_URL$/.test(k))) {
    const url = new URL(env[key] ?? "");
    url.pathname = key.startsWith("SHADOW") ? url.pathname : `/${name}`;
    env[key] = url.toString();
  }
  try {
    const created =
      (await psql("postgres", `CREATE DATABASE ${name} OWNER migrator TEMPLATE template0`)) &&
      (await psql(
        name,
        `REVOKE ALL ON DATABASE ${name} FROM PUBLIC; GRANT CONNECT ON DATABASE ${name} TO ${roles}; ` +
          "REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE EXTENSION vector; CREATE EXTENSION pg_trgm",
      ));
    return (
      created && (await passes(ctx, "bun", ["run", "db:deploy"], env)) && (await use(env, name))
    );
  } finally {
    await psql("postgres", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

/** The migrations apply to an empty database and match the Prisma schema (CI's integration job). */
const drift = (ctx: Context) =>
  withDatabase(ctx, "drift", (env) =>
    passes(ctx, "bun", ["run", "--cwd", "packages/db", "drift"], env),
  );

/**
 * CI's e2e job, all four shards in one run: its environment, with this machine's ports
 * (.env.example), fresh secrets, a database of its own and ClamAV's stand-in unless ClamAV
 * runs. Every other variable .env.example names is set empty, so a developer's .env
 * (which the services read too) can't turn on what CI leaves off.
 */
async function endToEnd(ctx: Context) {
  const local = testEnvironment(join(ctx.root, ".env.example"));
  // .env.example sets CLAMAV_URL; without it the URL fails to parse and the step says so.
  const clamd = await ctx.clamd(local.CLAMAV_URL ?? "");
  try {
    return await withDatabase(ctx, "e2e", async (database, name) => {
      const unset = Object.fromEntries(
        [...readEnv(join(ctx.root, ".env.example")).keys()].map((key) => [key, ""]),
      );
      const ci = jobEnv("ci.yml", "e2e", ctx.root);
      // A Valkey database of its own, emptied first like CI's fresh one: the dev stack's
      // keeps rate limits and queues from earlier runs (docs/testing.md has the numbers).
      const redis = new URL(local.REDIS_URL ?? "");
      redis.pathname = "/21";
      const env = {
        ...unset,
        ...ci,
        ...local,
        ...database,
        REDIS_URL: redis.toString(),
        CLAMAV_URL: clamd.url,
        NODE_ENV: "test",
      };
      const valkey = ["compose", "exec", "-T", "valkey", "valkey-cli", "-n", "21", "flushdb"];
      return (
        (await passes(ctx, "docker", valkey)) &&
        // Two Playwright workers, as on each CI runner: the local default of four, next to
        // the other steps, measures the machine rather than the app.
        (await passes(ctx, "bun", ["scripts/e2e.ts", "--workers=2"], env)) &&
        (await passes(ctx, "bun", ["run", "--cwd", "apps/web", "budget"])) &&
        (await passes(ctx, "bun", ["run", "db:restore-drill", name]))
      );
    });
  } finally {
    await clamd.close();
  }
}

/** The CodeQL languages of what the push changes. */
export function codeqlLanguages(files: string[]) {
  const languages: [string, RegExp][] = [
    ["actions", /^\.github\/(workflows|actions)\//],
    ["javascript-typescript", /\.(c|m)?(j|t)sx?$/],
    ["python", /\.py$/],
  ];
  return languages.filter(([, pattern]) => files.some((f) => pattern.test(f))).map(([l]) => l);
}

/** Every package bun.lock installs, `name@version` by install path; workspaces left out. */
export function lockedPackages(lock: string) {
  const packages = new Map<string, string>();
  for (const [, path = "", spec = ""] of lock.matchAll(/^ {4}"([^"]+)": \["([^"]+)"/gm)) {
    if (!spec.includes("@workspace:")) {
      packages.set(path, spec);
    }
  }
  return packages;
}

/** The license an installed package declares (bun.lock's install path), if any. */
export function licenseOf(root: string, path: string) {
  const dir = (path.match(/@[^/]+\/[^/]+|[^/]+/g) ?? []).map((name) => `node_modules/${name}`);
  const manifest = join(root, ...dir, "package.json");
  if (!existsSync(manifest)) {
    return undefined;
  }
  const { license } = z
    .object({ license: z.unknown() })
    .parse(JSON.parse(readFileSync(manifest, "utf8")));
  return typeof license === "string" ? license : undefined;
}

/** Whether an SPDX expression leaves a way to use the package under `allowed` licenses. */
export function allowedLicense(expression: string, allowed: Set<string>) {
  return expression
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/)
    .some((choice) => choice.split(/\s+AND\s+/).every((id) => allowed.has(id.trim())));
}

/** security.yml's dependency review, for the npm packages the push adds or upgrades. */
async function licenses(ctx: Context) {
  const step = workflow("security.yml", ctx.root).jobs.dependencies?.steps?.find(
    (s) => s.with?.["allow-licenses"],
  );
  const allowed = new Set(
    String(step?.with?.["allow-licenses"])
      .split(/[\s,]+/)
      .filter(Boolean),
  );
  const before = await ctx.exec("git", ["show", `${ctx.base}:bun.lock`], {
    cwd: ctx.root,
    quiet: true,
  });
  const known = new Set(lockedPackages(before.stdout).values());
  const now = lockedPackages(readFileSync(join(ctx.root, "bun.lock"), "utf8"));
  let passed = true;
  for (const [path, spec] of now) {
    const license = known.has(spec) ? "" : licenseOf(ctx.root, path);
    if (license === undefined) {
      ctx.log(`${spec} declares no license: CI's dependency review shows it as unknown.\n`);
    } else if (license && !allowedLicense(license, allowed)) {
      ctx.log(`${spec}: ${license} isn't among security.yml's allow-licenses.\n`);
      passed = false;
    }
  }
  return passed;
}

/**
 * CI's unit, components, integration, python and coverage jobs: every suite of what the
 * push affects. With the mail server up, the real mail path's suites run too, pointed at it
 * the way CI's integration job points them (they're skipped without it).
 */
function coverage(ctx: Context) {
  const mail = ctx.skipped.has("mail server")
    ? {}
    : Object.fromEntries(
        Object.entries(jobEnv("ci.yml", "integration", ctx.root)).filter(([key]) =>
          key.startsWith("STALWART_"),
        ),
      );
  return passes(ctx, "bun", ["scripts/push-coverage.ts", `--concurrency=${ctx.suites}`], mail);
}

/**
 * Every step, in the order they start when they can: what the others need, the quick
 * checks (seconds: a failure stops the push early), the coverage suites (the longest lane,
 * so it starts early), the few-minute checks, then the rest. `memory` and `docker` are
 * rough peaks, in GB, for the scheduler.
 */
export const STEPS: Step[] = [
  {
    name: "python dependencies",
    jobs: [],
    areas: [],
    keep: true,
    memory: 0.5,
    run: async (ctx) =>
      (await ctx.exec("uv", ["sync", "--locked"], { cwd: join(ctx.root, "apps/ai") })).status === 0,
  },
  {
    name: "generated code",
    jobs: ["ci.yml:codegen"],
    areas: ["app"],
    needs: ["python dependencies"],
    keep: true,
    cores: 2,
    memory: 2,
    run: generatedCode,
  },
  {
    name: "services",
    jobs: [],
    areas: ["app"],
    keep: true,
    memory: 0.2,
    run: async (ctx) =>
      (await passes(ctx, "bun", ["scripts/services.ts", "up"])) &&
      passes(ctx, "docker", ["compose", "--profile", "files", "up", "-d", "--wait", "rustfs"]),
  },
  {
    name: "mail server",
    jobs: [],
    areas: ["app"],
    keep: true,
    memory: 0.2,
    docker: 0.3,
    run: async (ctx) =>
      (await passes(ctx, "bun", ["scripts/services.ts", "up", "--mail"])) &&
      passes(ctx, "docker", ["compose", "--profile", "mail", "run", "--rm", "stalwart-init"]),
  },
  {
    name: "secrets",
    jobs: ["security.yml:secrets"],
    areas: [],
    memory: 0.2,
    docker: 0.25,
    run: (ctx) => passes(ctx, "bun", ["scripts/secret-scan.ts", `--range=${ctx.base}..HEAD`]),
  },
  {
    name: "dependency licenses",
    jobs: ["security.yml:dependencies"],
    areas: [],
    skip: (files) => (files.includes("bun.lock") ? undefined : "no npm dependency changed"),
    memory: 0.2,
    run: licenses,
  },
  {
    name: "known vulnerabilities",
    jobs: ["security.yml:osv"],
    areas: [],
    memory: 0.2,
    docker: 0.5,
    run: (ctx) => passes(ctx, "bun", ["scripts/osv.ts"]),
  },
  {
    name: "misconfigurations",
    jobs: ["security.yml:misconfig"],
    areas: [],
    cores: 2,
    memory: 1,
    docker: 0.5,
    run: (ctx) => passes(ctx, "bun", ["scripts/misconfig.ts"]),
  },
  {
    name: "third-party images",
    jobs: ["security.yml:images"],
    areas: [],
    memory: 0.5,
    run: (ctx) => passes(ctx, "bun", ["scripts/image-scan.ts"]),
  },
  {
    name: "migration safety",
    jobs: ["ci.yml:migrations"],
    areas: ["app"],
    memory: 0.5,
    run: (ctx) => passes(ctx, "bun", ["run", "db:lint"]),
  },
  {
    name: "API compatibility",
    jobs: ["ci.yml:api-compat"],
    areas: ["app"],
    needs: ["generated code"],
    memory: 0.5,
    docker: 0.25,
    run: apiCompatibility,
  },
  {
    name: "charts",
    jobs: ["ci.yml:charts"],
    areas: ["charts"],
    cores: 2,
    memory: 1,
    run: (ctx) => passes(ctx, "bun", ["run", "charts:check"]),
  },
  { name: "infra", jobs: ["ci.yml:infra"], areas: ["infra"], cores: 2, memory: 1, run: infra },
  {
    name: "coverage",
    jobs: [
      "ci.yml:unit",
      "ci.yml:components",
      "ci.yml:integration",
      "ci.yml:python",
      "ci.yml:coverage",
    ],
    areas: ["app", "scripts"],
    needs: ["generated code", "services", "mail server"],
    lane: "valkey",
    cores: 4,
    memory: 6,
    run: coverage,
  },
  {
    name: "lint",
    jobs: ["ci.yml:lint"],
    areas: [],
    needs: ["python dependencies", "generated code"],
    cores: 4,
    memory: 3,
    // The pinned linters (actionlint, zizmor, shellcheck, hadolint, tflint) run in Docker
    // when they aren't installed.
    docker: 0.25,
    run: (ctx) => passes(ctx, "bun", ["run", "lint"]),
  },
  {
    name: "types",
    jobs: ["ci.yml:types"],
    areas: ["app"],
    needs: ["generated code"],
    cores: 4,
    memory: 4,
    run: (ctx) => passes(ctx, "bun", ["run", "check-types"]),
  },
  {
    name: "type coverage",
    jobs: ["ci.yml:types"],
    areas: ["app"],
    needs: ["generated code"],
    cores: 2,
    memory: 3,
    run: (ctx) => passes(ctx, "bun", ["run", "type-coverage"]),
  },
  {
    name: "e2e",
    jobs: ["ci.yml:e2e"],
    areas: ["app"],
    needs: ["generated code", "services"],
    cores: 6,
    memory: 6,
    docker: 0.5,
    run: endToEnd,
  },
  {
    name: "codeql",
    jobs: ["security.yml:codeql"],
    areas: [],
    skip: (files) =>
      codeqlLanguages(files).length > 0 ? undefined : "no code CodeQL reads changed",
    cores: 4,
    memory: 4,
    run: (ctx) =>
      passes(ctx, "bun", ["run", "codeql", "--languages", codeqlLanguages(ctx.files).join(",")]),
  },
  {
    name: "generators",
    jobs: ["ci.yml:generators"],
    areas: ["app"],
    needs: ["generated code", "services"],
    lane: "valkey",
    // Stopped half way, it would leave its scratch worktree behind.
    keep: true,
    cores: 3,
    memory: 4,
    run: (ctx) => passes(ctx, "bun", ["scripts/generators.ts"]),
  },
  {
    name: "evals",
    jobs: ["ci.yml:python"],
    areas: ["app"],
    needs: ["generated code"],
    memory: 1,
    run: async (ctx) =>
      (await ctx.exec("uv", ["run", "python", "-m", "evals"], { cwd: join(ctx.root, "apps/ai") }))
        .status === 0,
  },
  {
    name: "migrations match the schema",
    jobs: ["ci.yml:integration"],
    areas: ["app"],
    needs: ["services"],
    memory: 1,
    run: drift,
  },
  {
    name: "screenshots",
    jobs: ["ci.yml:components"],
    areas: ["app"],
    needs: ["generated code"],
    cores: 2,
    memory: 2,
    docker: 1.5,
    run: (ctx) => passes(ctx, "bun", ["run", "--cwd", "packages/ui", "test:visual"]),
  },
];

/** What CI checks that this hook can't, and why. */
export const CI_ONLY: Record<string, string> = {
  "ci.yml:images":
    "builds the seven images, scans them with Trivy and starts each: more than a 2 GB Docker VM holds",
  "ci.yml:evals": "measures a real model with the provider's keys, nightly",
  "ci.yml:pr-title":
    "there's no pull request yet; the commit-msg hook checked every commit's header",
  "infra.yml:drift": "plans every environment nightly against the real cloud accounts",
  "claude-review.yml:review":
    "a model's review of the pull request, with its key; advice, not a check",
  "infra.yml:plan": "plans against the real cloud accounts, which needs their secrets",
  "infra.yml:apply": "runs by hand, never on a pull request",
  "kind.yml:kind": "deploys to a kind cluster, which needs 8 GB of Docker memory",
  "preview.yml:images": "a preview environment, for a pull request labelled preview",
  "preview.yml:cleanup": "removes a preview environment when its pull request closes",
};

/**
 * Jobs that never run on a pull request: they ship what merged, or watch what's running.
 * Listed so that every job of every workflow is decided (scripts/pre-push.test.ts).
 */
export const AFTER_MERGE: Record<string, string> = {
  "deploy.yml:build": "builds the images of a commit on master",
  "deploy.yml:publish": "publishes them to the registry",
  "deploy.yml:attest": "attests each published image's SBOM, with the registry's digests",
  "deploy.yml:staging": "deploys them to staging",
  "mobile.yml:eas": "builds the mobile app in Expo's cloud after a release",
  "release.yml:release": "tags a release from master",
  "renovate.yml:renovate": "opens dependency updates on a schedule",
  "stripe.yml:contract": "checks the fake Stripe against Stripe's real test API, weekly",
  "uptime.yml:probe": "probes the running environments from outside",
};

/** Jobs that check nothing themselves: they find the areas or gather the others' results. */
export const BOOKKEEPING = new Set([
  "ci.yml:changes",
  "ci.yml:ci-ok",
  "security.yml:security-ok",
  "infra.yml:changes",
  "infra.yml:targets",
  "infra.yml:infra-ok",
  "kind.yml:changes",
  "kind.yml:kind-ok",
]);

/** How much the steps may use at once: cores and memory (GB). */
export function limits(env: Record<string, string | undefined>, cpus: number, memory: number) {
  const number = (value: string | undefined) => (Number(value) > 0 ? Number(value) : undefined);
  const cores = number(env.PRE_PUSH_CONCURRENCY) ?? Math.max(1, cpus - 1);
  return { cores, memory: number(env.PRE_PUSH_MEMORY_GB) ?? Math.max(2, memory / GB - 2) };
}

export interface Result {
  name: string;
  status: "passed" | "failed" | "skipped" | "stopped";
  note?: string;
  seconds?: number;
}

type Room = { cores: number; memory: number; docker: number };
type Launch = (step: Step, signal: AbortSignal) => Promise<boolean>;
type Finished = { step: Step; passed: boolean; seconds: number };
type Started = { step: Step; controller: AbortController; done: Promise<Finished> };

/** Whether `step` can start now, next to `running`. */
function startable(step: Step, results: Map<string, Result>, running: Started[], room: Room) {
  const used = (key: "cores" | "memory" | "docker") =>
    running.reduce((sum, r) => sum + (r.step[key] ?? (key === "cores" ? 1 : 0)), 0);
  return (
    (step.needs ?? []).every((need) =>
      ["passed", "skipped"].includes(results.get(need)?.status ?? ""),
    ) &&
    !running.some((r) => step.lane && r.step.lane === step.lane) &&
    (running.length === 0 ||
      (used("cores") + (step.cores ?? 1) <= room.cores &&
        used("memory") + step.memory <= room.memory)) &&
    (!step.docker ||
      running.every((r) => !r.step.docker) ||
      used("docker") + step.docker <= room.docker)
  );
}

/** Starts a step, timing it. */
function begin(step: Step, launch: Launch): Started {
  const controller = new AbortController();
  const at = Date.now();
  const done = launch(step, controller.signal).then((passed) => ({
    step,
    passed,
    seconds: (Date.now() - at) / 1000,
  }));
  return { step, controller, done };
}

/**
 * Runs the steps, each as soon as what it needs has passed and there's room, and stops
 * them all at the first failure; every step's result, in the steps' order.
 */
export async function schedule(
  steps: Step[],
  skipped: Map<string, string>,
  room: Room,
  launch: Launch,
) {
  const results = new Map<string, Result>();
  for (const [name, note] of skipped) {
    results.set(name, { name, status: "skipped", note });
  }
  const waiting = steps.filter((step) => !skipped.has(step.name));
  const running: Started[] = [];
  // A lane's steps start in their order: a later, smaller one never takes the lane from one
  // still waiting for room (the coverage suites before the generators' check).
  const startWhatCan = () => {
    const held = new Set<string>();
    for (const step of [...waiting]) {
      if (step.lane && held.has(step.lane)) {
        continue;
      }
      if (startable(step, results, running, room)) {
        waiting.splice(waiting.indexOf(step), 1);
        running.push(begin(step, launch));
      } else if (step.lane) {
        held.add(step.lane);
      }
    }
  };
  let failed = false;
  startWhatCan();
  while (running.length > 0) {
    const { step, passed, seconds } = await Promise.race(running.map((r) => r.done));
    running.splice(
      running.findIndex((r) => r.step === step),
      1,
    );
    let status: Result["status"] = "passed";
    if (!passed) {
      status = failed ? "stopped" : "failed";
      failed = true;
      for (const other of running.filter((r) => !r.step.keep)) {
        other.controller.abort();
      }
    }
    results.set(step.name, { name: step.name, status, seconds });
    if (!failed) {
      startWhatCan();
    }
  }
  return steps.map(
    (step) => results.get(step.name) ?? { name: step.name, status: "stopped" as const },
  );
}

/** Runs commands for a step: in their own process group, killed when `signal` aborts. */
export function spawnExec(signal: AbortSignal, log: (text: string) => void): Exec {
  const exec: Exec = (command, args, options = {}) =>
    new Promise((resolve) => {
      const spawnOptions: SpawnOptions = {
        cwd: options.cwd ?? ROOT,
        env: { ...process.env, ...options.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      };
      const child = spawn(command, args, spawnOptions);
      const output = { stdout: "", stderr: "" };
      const keep = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
        output[stream] += String(chunk);
        if (!options.quiet) {
          log(String(chunk));
        }
      };
      child.stdout?.on("data", keep("stdout"));
      child.stderr?.on("data", keep("stderr"));
      // The whole group: the step's command and everything it started (turbo's tasks).
      const stop = () =>
        child.exitCode === null && child.pid && process.kill(-child.pid, "SIGTERM");
      signal.addEventListener("abort", stop, { once: true });
      child.on("error", (error) => keep("stderr")(Buffer.from(`${error.message}\n`)));
      child.on("close", (status) => {
        signal.removeEventListener("abort", stop);
        resolve({ status, ...output });
      });
    });
  return exec;
}

/** The summary: every step's result and time, then what only CI checks. */
function summary(results: Result[]) {
  console.log("\nPre-push summary");
  for (const { name, status, note, seconds } of results) {
    const time = seconds === undefined ? "" : `${seconds.toFixed(0)}s`;
    const label = {
      passed: "ran, passed",
      failed: "ran, FAILED",
      skipped: "skipped",
      stopped: "stopped",
    }[status];
    console.log(
      `  ${name.padEnd(28)} ${label.padEnd(12)} ${time.padStart(6)}  ${note ?? ""}`.trimEnd(),
    );
  }
  console.log("\nCI only:");
  for (const [job, reason] of Object.entries(CI_ONLY)) {
    console.log(`  ${job.padEnd(28)} ${reason}`);
  }
}

/** Why `step` is skipped, if it is: PRE_PUSH_SKIP, its areas untouched, or its own reason. */
function skipReason(step: Step, touched: Record<Area, boolean>, files: string[], asked: string[]) {
  if (asked.includes(step.name)) {
    return "PRE_PUSH_SKIP (CI still runs it)";
  }
  if (step.areas.length > 0 && !step.areas.some((area) => touched[area])) {
    return `area untouched (${step.areas.join(", ")})`;
  }
  return step.skip?.(files);
}

/** The steps that are skipped, with the reason. */
export function skips(touched: Record<Area, boolean>, files: string[], skip = "") {
  const asked = skip.split(",").map((name) => name.trim());
  return new Map(
    STEPS.flatMap((step) => {
      const reason = skipReason(step, touched, files, asked);
      return reason ? [[step.name, reason] as const] : [];
    }),
  );
}

/** What the push sends: its base, the files it changes, a commit declaring a breaking change. */
function pushed(root: string, run: Run) {
  const git = (args: string[]) => run("git", args, { cwd: root });
  const base = pushBase((args) => git(args).stdout);
  const diff = git(["diff", "--name-only", base, "HEAD"]);
  if (diff.status !== 0) {
    fail(`git diff against ${base} failed: ${diff.stderr.trim()}`);
    return undefined;
  }
  if (git(["status", "--porcelain"]).stdout.trim()) {
    warn("Uncommitted changes: the checks see the working tree, the push sends only commits.");
  }
  const breaking = git(["log", "--format=%s", `${base}..HEAD`])
    .stdout.split("\n")
    .find((subject) => /^[a-z]+(\([a-z-]+\))?!:/.test(subject));
  return { base, files: diff.stdout.split("\n").filter(Boolean), breaking };
}

/** Starts one step with its own log: printed whole when it fails, one line when it passes. */
function launcher(
  shared: Omit<Context, "exec" | "log">,
  room: Room,
  exec: typeof spawnExec,
): Launch {
  return async (step, signal) => {
    if ((step.docker ?? 0) > room.docker) {
      fail(
        `${step.name} needs ${step.docker} GB of Docker memory, and Docker has ${room.docker.toFixed(1)} GB free (is it running?)`,
      );
      return false;
    }
    const output: string[] = [];
    const log = (text: string) => output.push(text);
    const passed = await step
      .run({ ...shared, exec: exec(signal, log), log })
      .catch((error: unknown) => {
        log(`${error instanceof Error ? error.message : String(error)}\n`);
        return false;
      });
    if (passed) {
      ok(step.name);
    } else if (!signal.aborted) {
      fail(step.name);
      console.error(output.join("").trimEnd());
    }
    return passed;
  };
}

/** What the hook runs with; the tests replace parts. */
export const MACHINE = {
  root: ROOT,
  env: process.env,
  run: runSync,
  exec: spawnExec,
  clamd: clamdFor,
  cpus: availableParallelism(),
  memory: totalmem(),
  onInterrupt: (stop: () => void): unknown => process.once("SIGINT", stop),
};

/** The hook; the exit code. */
export async function prePush(given: Partial<typeof MACHINE> = {}): Promise<number> {
  const { root, env, run, exec, clamd, cpus, memory, onInterrupt } = { ...MACHINE, ...given };
  const push = pushed(root, run);
  if (!push) {
    return 1;
  }
  const docker = dockerMemory(run);
  const free = Number.isFinite(docker.free) ? Math.max(0, docker.free / GB) : 0;
  const room = { ...limits(env, cpus, memory), docker: free };
  // About one coverage suite per GB of Docker memory: they share its Postgres and Valkey, and
  // two at a time is what a 2 GB Docker holds without timing-sensitive tests turning flaky.
  const suites = Math.max(1, Math.min(room.cores, Math.floor((docker.total || 0) / GB)));
  const touched = areas(push.files);
  const skipped = skips(touched, push.files, env.PRE_PUSH_SKIP);
  const shared = { root, ...push, areas: touched, suites, clamd, skipped: new Set(skipped.keys()) };
  const interrupted = new AbortController();
  onInterrupt(() => interrupted.abort());
  const stoppable: typeof spawnExec = (signal, log) =>
    exec(AbortSignal.any([signal, interrupted.signal]), log);
  console.log(
    `Pre-push: ${push.files.length} files changed since ${push.base.slice(0, 12)}, ${room.cores} cores and ${room.memory.toFixed(0)} GB for the steps`,
  );
  const results = await schedule(STEPS, skipped, room, launcher(shared, room, stoppable));
  summary(results);
  const failed = results.find((result) => result.status === "failed");
  if (interrupted.signal.aborted) {
    fail("interrupted");
    return 130;
  }
  if (failed) {
    fail(`${failed.name} failed: fix it, or push with --no-verify and let CI decide.`);
    return 1;
  }
  ok("every check CI runs that can run here passed");
  return 0;
}

await runMain(import.meta, prePush);
