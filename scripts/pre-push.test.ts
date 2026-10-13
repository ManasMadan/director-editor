import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Area } from "./changes";
import { PLACEHOLDER, type Ran, ROOT } from "./lib";
import {
  AFTER_MERGE,
  allowedLicense,
  BOOKKEEPING,
  CI_ONLY,
  type Context,
  codeqlLanguages,
  jobEnv,
  licenseOf,
  limits,
  lockedPackages,
  MACHINE,
  prePush,
  type Result,
  STEPS,
  type Step,
  schedule,
  skips,
  spawnExec,
  workflow,
} from "./pre-push";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const GB = 1024 ** 3;
const none: Record<Area, boolean> = {
  app: false,
  charts: false,
  infra: false,
  images: false,
  scripts: false,
};

/** A step's context whose commands are recorded, answered by `answer`. */
function context(
  answer: (line: string) => Partial<Ran> | undefined = () => undefined,
  given: Partial<Context> = {},
) {
  const { run, calls, options } = fakeRun(answer);
  const logs: string[] = [];
  const closed: string[] = [];
  const ctx: Context = {
    root: ROOT,
    base: "abc",
    files: [],
    areas: { ...none, app: true },
    breaking: undefined,
    suites: 3,
    skipped: new Set(),
    clamd: async () => ({
      url: "tcp://127.0.0.1:9",
      close: async () => {
        closed.push("clamd");
      },
    }),
    exec: async (command, args, options = {}) => run(command, args, options),
    log: (text) => logs.push(text),
    ...given,
  };
  return { ctx, calls, options, closed, logged: () => logs.join("") };
}

const step = (name: string) => {
  const found = STEPS.find((s) => s.name === name);
  if (!found) {
    throw new Error(`no step ${name}`);
  }
  return found;
};

describe("every job of every workflow", () => {
  const dir = join(ROOT, ".github/workflows");
  const files = readdirSync(dir).filter((file) => file.endsWith(".yml"));
  const triggers = (file: string) =>
    Object.keys((Bun.YAML.parse(readFileSync(join(dir, file), "utf8")) as { on: object }).on);
  const jobs = files.flatMap((file) =>
    Object.keys(workflow(file).jobs).map((job) => `${file}:${job}`),
  );
  const mirrored = new Set(STEPS.flatMap((s) => s.jobs));
  const decided = (job: string) =>
    mirrored.has(job) || job in CI_ONLY || job in AFTER_MERGE || BOOKKEEPING.has(job);

  it("has a pre-push step, or a reason why only CI runs it", () => {
    expect(jobs.length).toBeGreaterThan(30);
    expect(jobs.filter((job) => !decided(job))).toEqual([]);
  });

  it("is named only as it exists, in one list, with a reason", () => {
    const named = [
      ...mirrored,
      ...Object.keys(CI_ONLY),
      ...Object.keys(AFTER_MERGE),
      ...BOOKKEEPING,
    ];
    expect(named.filter((job) => !jobs.includes(job))).toEqual([]);
    expect(named.filter((job, index) => named.indexOf(job) !== index)).toEqual([]);
    const reasons = [...Object.values(CI_ONLY), ...Object.values(AFTER_MERGE)];
    expect(reasons.filter((reason) => reason.length < 20)).toEqual([]);
  });

  it("runs after merging only in a workflow no pull request starts", () => {
    const onPullRequests = files.filter((file) =>
      ["pull_request", "merge_group"].some((trigger) => triggers(file).includes(trigger)),
    );
    const wrong = Object.keys(AFTER_MERGE).filter((job) =>
      onPullRequests.includes(job.split(":")[0] ?? ""),
    );
    expect(wrong).toEqual([]);
  });
});

/**
 * Every step of every job the hook mirrors, by its name (or its command, or its action), and
 * what stands for it here: a pre-push step, or "setup: …" for what only prepares a CI
 * runner. A step added to one of these jobs fails the test below until it's mirrored too.
 */
const COUNTERPARTS: Record<string, Record<string, string>> = {
  "ci.yml:lint": { "bun run lint": "lint" },
  "ci.yml:types": { "bun run check-types": "types", "bun run type-coverage": "type coverage" },
  "ci.yml:unit": {
    "bun run test": "coverage",
    "bun test --coverage ./scripts/ ./.claude/hooks/ && bun scripts/coverage.ts --bun": "coverage",
  },
  "ci.yml:components": {
    "Install the browser": "setup: Playwright's Chromium, already on a developer's machine",
    "Every story renders, passes its play function and axe, in both themes": "coverage",
    "Screenshots match the baselines": "screenshots",
  },
  "ci.yml:integration": {
    "The repo's tooling (scripts, hooks and the rest Bun's runner owns), with coverage": "coverage",
    "The day, for the signatures' cache key": "setup: a cache key",
    "Start object storage and virus scanning": "services",
    "Start Valkey": "services",
    "Bootstrap database roles": "setup: infra/postgres/init, when compose creates the database",
    "Apply migrations": "migrations match the schema",
    "Migrations match the Prisma schema": "migrations match the schema",
    "Wait for storage and clamd, and create the bucket": "services",
    "Start the mail server": "mail server",
    "Install Chromium": "setup: Playwright's Chromium, already on a developer's machine",
    "Tests with coverage": "coverage",
  },
  "ci.yml:e2e": {
    "The day, for the signatures' cache key": "setup: a cache key",
    "Start object storage and virus scanning": "services",
    "Bootstrap database roles": "setup: infra/postgres/init, when compose creates the database",
    "bun run db:deploy": "e2e",
    "Generate throwaway secrets": "e2e",
    "Install the browser": "setup: Playwright's Chromium, already on a developer's machine",
    "Wait for storage and clamd, and create the bucket": "services",
    "Run the end-to-end suite": "e2e",
    "Bundle budget": "e2e",
    "Restore drill": "e2e",
  },
  "ci.yml:python": {
    "uv run ruff check .": "lint",
    "uv run ruff format --check .": "lint",
    "uv run basedpyright": "types",
    "uv run pytest": "coverage",
    Evals: "evals",
    "Bootstrap database roles and migrate":
      "setup: infra/postgres/init and the suites' own migration",
    "All tests with coverage": "coverage",
  },
  "ci.yml:codegen": {
    "bun run gen": "generated code",
    "Fail if generation changed or added files": "generated code",
  },
  "ci.yml:api-compat": {
    "Breaking changes": "API compatibility",
    "Event compatibility": "API compatibility",
  },
  "ci.yml:migrations": { "bun run db:lint": "migration safety" },
  "ci.yml:charts": {
    "Install helm-unittest": "setup: the developer's helm plugin (charts:check says how to add it)",
    "bun run charts:check": "charts",
  },
  "ci.yml:infra": { "bun run infra:check": "infra" },
  "ci.yml:generators": {
    "Bootstrap database roles": "setup: infra/postgres/init, when compose creates the database",
    "bun run db:deploy": "setup: the feature's integration test migrates its own template",
    "bun scripts/generators.ts --in-place": "generators",
  },
  "ci.yml:coverage": {
    "Every file at 100%": "coverage",
    "Every changed line covered": "coverage",
  },
  "security.yml:codeql": {
    "github/codeql-action/init": "codeql",
    "github/codeql-action/analyze": "codeql",
  },
  "security.yml:secrets": { "gitleaks/gitleaks-action": "secrets" },
  "security.yml:dependencies": { "actions/dependency-review-action": "dependency licenses" },
  "security.yml:misconfig": {
    "bun scripts/misconfig.ts --format sarif --output trivy-config.sarif": "misconfigurations",
    "github/codeql-action/upload-sarif": "setup: sends the findings to the Security tab",
  },
  "security.yml:images": {
    "The day, for the database's cache key": "setup: a cache key",
    "bun scripts/image-scan.ts": "third-party images",
  },
  "security.yml:osv": {
    "google/osv-scanner-action/osv-scanner-action": "known vulnerabilities",
    "github/codeql-action/upload-sarif": "setup: sends the findings to the Security tab",
  },
};

/** What only sets a runner up: the toolchain, caches, artifacts. */
const RUNNER_SETUP =
  /^(step-security\/harden-runner|actions\/(checkout|cache|upload-artifact|download-artifact)|\.\/\.github\/actions\/(setup|free-disk)|azure\/setup-helm|opentofu\/setup-opentofu|oven-sh\/setup-bun|aquasecurity\/setup-trivy)@?/;

describe("every step of a job the hook mirrors", () => {
  type CiStep = { name?: string; run?: string; uses?: string };
  const steps = (file: string, job: string) => {
    const parsed = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows", file), "utf8")) as {
      jobs: Record<string, { steps?: CiStep[] }>;
    };
    return (parsed.jobs[job]?.steps ?? [])
      .filter((s) => !s.uses || !RUNNER_SETUP.test(s.uses))
      .map((s) => s.name ?? s.run?.trim().split("\n")[0] ?? s.uses?.split("@")[0] ?? "");
  };
  const mirrored = [...new Set(STEPS.flatMap((s) => s.jobs))];

  it("has a counterpart here, named in COUNTERPARTS", () => {
    const missing = mirrored.flatMap((id) => {
      const [file = "", job = ""] = id.split(":");
      return steps(file, job)
        .filter((name) => !COUNTERPARTS[id]?.[name])
        .map((name) => `${id}: ${name}`);
    });
    expect(missing).toEqual([]);
  });

  it("is listed only as it exists, against a step that exists", () => {
    const names = new Set(STEPS.map((s) => s.name));
    for (const [id, counterparts] of Object.entries(COUNTERPARTS)) {
      const [file = "", job = ""] = id.split(":");
      expect({ id, steps: Object.keys(counterparts).sort() }).toEqual({
        id,
        steps: [...new Set(steps(file, job))].sort(),
      });
      for (const local of Object.values(counterparts)) {
        expect({ id, local, known: local.startsWith("setup: ") || names.has(local) }).toEqual({
          id,
          local,
          known: true,
        });
      }
    }
    expect(Object.keys(COUNTERPARTS).sort()).toEqual(mirrored.sort());
  });
});

describe("the steps", () => {
  it("have distinct names, and need only steps listed before them", () => {
    const names = STEPS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [index, s] of STEPS.entries()) {
      for (const need of s.needs ?? []) {
        expect(names.slice(0, index)).toContain(need);
      }
    }
  });

  it("run the package scripts CI's jobs run", async () => {
    const expected: Record<string, string[]> = {
      "python dependencies": ["uv sync --locked"],
      services: [
        "bun scripts/services.ts up",
        "docker compose --profile files up -d --wait rustfs",
      ],
      "mail server": [
        "bun scripts/services.ts up --mail",
        "docker compose --profile mail run --rm stalwart-init",
      ],
      secrets: ["bun scripts/secret-scan.ts --range=abc..HEAD"],
      "known vulnerabilities": ["bun scripts/osv.ts"],
      misconfigurations: ["bun scripts/misconfig.ts"],
      "migration safety": ["bun run db:lint"],
      charts: ["bun run charts:check"],
      coverage: ["bun scripts/push-coverage.ts --concurrency=3"],
      lint: ["bun run lint"],
      types: ["bun run check-types"],
      "type coverage": ["bun run type-coverage"],
      codeql: ["bun run codeql --languages javascript-typescript,python"],
      generators: ["bun scripts/generators.ts"],
      evals: ["uv run python -m evals"],
      screenshots: ["bun run --cwd packages/ui test:visual"],
    };
    for (const [name, commands] of Object.entries(expected)) {
      const { ctx, calls } = context(undefined, { files: ["a.ts", "b.py"] });
      expect(await step(name).run(ctx)).toBe(true);
      expect({ name, calls }).toEqual({ name, calls: commands });
    }
  });

  it("point the coverage suites at the mail server, as CI's integration job does, when it runs", async () => {
    const withMail = context();
    await step("coverage").run(withMail.ctx);
    expect(withMail.options[0]?.env?.STALWART_URL).toBe(
      jobEnv("ci.yml", "integration").STALWART_URL,
    );
    const without = context(undefined, { skipped: new Set(["mail server"]) });
    await step("coverage").run(without.ctx);
    expect(without.options[0]?.env).toEqual({});
  });

  it("fail when their command does", async () => {
    for (const name of ["python dependencies", "services", "evals"]) {
      const { ctx } = context(() => ({ status: 1 }));
      expect(await step(name).run(ctx)).toBe(false);
    }
  });

  it("skip CodeQL and the license check when nothing they read changed", () => {
    expect(step("codeql").skip?.(["README.md"])).toBe("no code CodeQL reads changed");
    expect(step("dependency licenses").skip?.(["package.json"])).toBe("no npm dependency changed");
    expect(step("dependency licenses").skip?.(["bun.lock"])).toBeUndefined();
  });
});

describe("the generated code check", () => {
  it("passes when `bun run gen` changes nothing", async () => {
    const { ctx, calls } = context();
    expect(await step("generated code").run(ctx)).toBe(true);
    expect(calls).toContain("bun run gen");
  });

  it("fails when gen fails, or changes or adds a file", async () => {
    expect(
      await step("generated code").run(
        context((l) => (l === "bun run gen" ? { status: 1 } : undefined)).ctx,
      ),
    ).toBe(false);
    let statuses = 0;
    const { ctx, logged } = context((line) =>
      line.startsWith("git status --porcelain")
        ? { stdout: statuses++ ? "?? new.ts\n" : "" }
        : undefined,
    );
    expect(await step("generated code").run(ctx)).toBe(false);
    expect(logged()).toContain("Generated files are out of date");
  });
});

describe("API compatibility", () => {
  const image = jobEnv("ci.yml", "api-compat").OASDIFF;

  it("diffs both documents against the push's base with CI's oasdiff, then the events", async () => {
    const { ctx, calls, logged } = context((line) =>
      line === "git show abc:apps/api/openapi.json" ? { status: 128 } : { stdout: "{}" },
    );
    expect(await step("API compatibility").run(ctx)).toBe(true);
    expect(logged()).toContain("The base has no apps/api/openapi.json yet.");
    const docker = calls.filter((c) => c.startsWith("docker"));
    expect(docker).toHaveLength(1);
    expect(docker[0]).toContain(`${image} breaking /base/ai.json /head/openapi.json --fail-on ERR`);
    expect(calls.at(-1)).toBe("bun scripts/events-compat.ts abc");
  });

  it("fails on a breaking change, unless a commit declares one", async () => {
    const breaking = (line: string) =>
      line.startsWith("docker") || line.startsWith("bun") ? { status: 1 } : undefined;
    expect(await step("API compatibility").run(context(breaking).ctx)).toBe(false);
    const declared = context(breaking, { breaking: "feat(api)!: drop the v1 todos" });
    expect(await step("API compatibility").run(declared.ctx)).toBe(false);
    const eventsOnly = context((l) => (l.startsWith("bun") ? { status: 1 } : undefined), {
      breaking: "feat(api)!: drop the v1 todos",
    });
    expect(await step("API compatibility").run(eventsOnly.ctx)).toBe(true);
    expect(eventsOnly.logged()).toContain("declares a breaking change");
    expect(eventsOnly.calls.find((c) => c.startsWith("docker"))).not.toContain("--fail-on");
  });
});

describe("the infra check", () => {
  it("needs a local tofu", async () => {
    const { ctx, calls, logged } = context(() => ({ status: -2 }));
    expect(await step("infra").run(ctx)).toBe(false);
    expect(calls).toEqual(["tofu version"]);
    expect(logged()).toContain("OpenTofu isn't installed");
  });

  it("runs infra:check with it", async () => {
    const { ctx, calls } = context();
    expect(await step("infra").run(ctx)).toBe(true);
    expect(calls).toEqual(["tofu version", "bun run infra:check"]);
  });
});

describe("the database steps", () => {
  const database = `prepush_${process.pid}`;

  it("migrate a database of their own, check drift on it and drop it", async () => {
    const { ctx, calls, options } = context();
    expect(await step("migrations match the schema").run(ctx)).toBe(true);
    expect(calls[0]).toContain(
      `CREATE DATABASE ${database}_drift OWNER migrator TEMPLATE template0`,
    );
    expect(calls[1]).toContain("CREATE EXTENSION vector");
    expect(calls.slice(2, 4)).toEqual(["bun run db:deploy", "bun run --cwd packages/db drift"]);
    expect(calls[4]).toContain(`DROP DATABASE IF EXISTS ${database}_drift WITH (FORCE)`);
    const env = options[2]?.env ?? {};
    expect(env.MIGRATOR_DATABASE_URL).toBe(
      `postgresql://migrator:migrator@localhost:55432/${database}_drift`,
    );
    expect(env.AI_DATABASE_URL).toEndWith(`@localhost:55432/${database}_drift`);
    expect(env.SHADOW_DATABASE_URL).toEndWith("/app_shadow");
  });

  it("still drop it when creating it fails", async () => {
    const { ctx, calls } = context((line) =>
      line.includes("CREATE DATABASE") ? { status: 1 } : undefined,
    );
    expect(await step("migrations match the schema").run(ctx)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("DROP DATABASE");
  });

  it("run the e2e suite as CI's job does: its environment, this machine's ports", async () => {
    const { ctx, calls, options, closed } = context();
    expect(await step("e2e").run(ctx)).toBe(true);
    expect(calls.slice(3, 7)).toEqual([
      "docker compose exec -T valkey valkey-cli -n 21 flushdb",
      "bun scripts/e2e.ts --workers=2",
      "bun run --cwd apps/web budget",
      `bun run db:restore-drill ${database}_e2e`,
    ]);
    const env = options[4]?.env ?? {};
    expect(env.API_DATABASE_URL).toBe(
      `postgresql://app_api:app_api@localhost:55432/${database}_e2e`,
    );
    expect(env.REDIS_URL).toBe("redis://localhost:56379/21");
    expect(env.S3_BUCKET).toBe("uploads");
    expect(env.STRIPE_SECRET_KEY).toBe("sk_test_ci");
    expect(env.GOOGLE_CLIENT_ID).toBe("");
    expect(env.CLAMAV_URL).toBe("tcp://127.0.0.1:9");
    expect(env.NODE_ENV).toBe("test");
    expect(env.BETTER_AUTH_SECRET).not.toMatch(PLACEHOLDER);
    expect(closed).toEqual(["clamd"]);
  });

  it("stop the e2e run at its first failure, and close ClamAV's stand-in", async () => {
    const { ctx, calls, closed } = context((l) =>
      l === "bun scripts/e2e.ts --workers=2" ? { status: 1 } : undefined,
    );
    expect(await step("e2e").run(ctx)).toBe(false);
    expect(calls.some((c) => c.includes("budget"))).toBe(false);
    expect(closed).toEqual(["clamd"]);
  });
});

describe("the new dependencies' licenses", () => {
  const lock = (...entries: string[]) =>
    `{\n  "workspaces": {\n    "": { "name": "x" },\n  },\n  "packages": {\n${entries.map((e) => `    ${e},\n`).join("")}  }\n}\n`;
  const pkg = (root: string, path: string, manifest: object) => {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), JSON.stringify(manifest));
  };

  it("reads what bun.lock installs, and where", () => {
    const text = lock(
      `"@repo/ui": ["@repo/ui@workspace:packages/ui"]`,
      `"zod": ["zod@4.0.0", "", {}, "sha"]`,
      `"next/postcss": ["postcss@8.4.31", "", {}, "sha"]`,
    );
    expect([...lockedPackages(text)]).toEqual([
      ["zod", "zod@4.0.0"],
      ["next/postcss", "postcss@8.4.31"],
    ]);
  });

  it("finds a package's license where it's installed", () => {
    const root = mkdtempSync(join(tmpdir(), "licenses-"));
    pkg(root, "node_modules/@s/a/node_modules/b", { license: "MIT" });
    pkg(root, "node_modules/old", { license: { type: "MIT" } });
    expect(licenseOf(root, "@s/a/b")).toBe("MIT");
    expect(licenseOf(root, "old")).toBeUndefined();
    expect(licenseOf(root, "missing")).toBeUndefined();
  });

  it("reads SPDX expressions", () => {
    const allowed = new Set(["MIT", "Apache-2.0"]);
    expect(allowedLicense("(MIT OR GPL-3.0)", allowed)).toBe(true);
    expect(allowedLicense("MIT AND Apache-2.0", allowed)).toBe(true);
    expect(allowedLicense("MIT AND GPL-3.0", allowed)).toBe(false);
  });

  it("fails on a new package whose license security.yml doesn't allow, and notes unknown ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "licenses-"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    copyFileSync(
      join(ROOT, ".github/workflows/security.yml"),
      join(root, ".github/workflows/security.yml"),
    );
    const before = lock(`"kept": ["kept@1.0.0", "", {}, "sha"]`);
    writeFileSync(
      join(root, "bun.lock"),
      lock(
        `"kept": ["kept@1.0.0", "", {}, "sha"]`,
        `"fine": ["fine@1.0.0", "", {}, "sha"]`,
        `"viral": ["viral@1.0.0", "", {}, "sha"]`,
        `"unknown": ["unknown@1.0.0", "", {}, "sha"]`,
      ),
    );
    pkg(root, "node_modules/fine", { license: "MIT" });
    pkg(root, "node_modules/viral", { license: "GPL-3.0-only" });
    const { ctx, logged } = context(
      (line) => (line.startsWith("git show") ? { stdout: before } : undefined),
      { root },
    );
    expect(await step("dependency licenses").run(ctx)).toBe(false);
    expect(logged()).toContain(
      "viral@1.0.0: GPL-3.0-only isn't among security.yml's allow-licenses",
    );
    expect(logged()).toContain("unknown@1.0.0 declares no license");
    expect(logged()).not.toContain("fine@");
  });
});

describe("what decides which steps run", () => {
  it("reads a job's plain environment from its workflow", () => {
    expect(jobEnv("ci.yml", "e2e").S3_BUCKET).toBe("uploads");
    const root = mkdtempSync(join(tmpdir(), "workflows-"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/x.yml"),
      `jobs:\n  a:\n    env: { PLAIN: yes, SECRET: '$\{{ secrets.X }}', COUNT: 3 }\n  b: {}\n`,
    );
    expect(jobEnv("x.yml", "a", root)).toEqual({ PLAIN: "yes" });
    expect(jobEnv("x.yml", "b", root)).toEqual({});
    expect(jobEnv("x.yml", "missing", root)).toEqual({});
  });

  it("finds the CodeQL languages of the changed files", () => {
    expect(codeqlLanguages([".github/workflows/ci.yml", "a.py", "b.tsx", "README.md"])).toEqual([
      "actions",
      "javascript-typescript",
      "python",
    ]);
    expect(codeqlLanguages(["scripts/x.mjs"])).toEqual(["javascript-typescript"]);
  });

  it("skips a step whose areas the push leaves alone, or that PRE_PUSH_SKIP names", () => {
    const skipped = skips({ ...none, charts: true }, ["deploy/x.yaml"], "lint, charts");
    expect(skipped.get("charts")).toBe("PRE_PUSH_SKIP (CI still runs it)");
    expect(skipped.get("lint")).toBe("PRE_PUSH_SKIP (CI still runs it)");
    expect(skipped.get("coverage")).toBe("area untouched (app, scripts)");
    expect(skipped.get("codeql")).toBe("no code CodeQL reads changed");
    expect(skipped.has("secrets")).toBe(false);
    expect(skips(none, []).has("lint")).toBe(false);
  });

  it("sizes the run to the machine, unless told", () => {
    expect(limits({}, 10, 16 * GB)).toEqual({ cores: 9, memory: 14 });
    expect(limits({}, 1, 2 * GB)).toEqual({ cores: 1, memory: 2 });
    expect(limits({ PRE_PUSH_CONCURRENCY: "1", PRE_PUSH_MEMORY_GB: "6" }, 10, 16 * GB)).toEqual({
      cores: 1,
      memory: 6,
    });
    expect(limits({ PRE_PUSH_CONCURRENCY: "none" }, 4, 16 * GB).cores).toBe(3);
  });
});

describe("the scheduler", () => {
  const room = { cores: 8, memory: 10, docker: 2 };
  const make = (name: string, more: Partial<Step> = {}): Step => ({
    name,
    jobs: [],
    areas: [],
    memory: 1,
    run: async () => true,
    ...more,
  });

  /** Runs `steps`, failing those in `failing`; who ran beside whom, and the results. */
  async function run(
    steps: Step[],
    given = room,
    failing: string[] = [],
    skipped = new Map<string, string>(),
  ) {
    const active = new Set<string>();
    const together: string[][] = [];
    const aborted: string[] = [];
    const results = await schedule(steps, skipped, given, async (s, signal) => {
      active.add(s.name);
      together.push([...active].sort());
      signal.addEventListener("abort", () => aborted.push(s.name));
      await Bun.sleep(s.name.startsWith("slow") ? 30 : 5);
      active.delete(s.name);
      return !failing.includes(s.name);
    });
    return {
      together,
      aborted,
      results: Object.fromEntries(results.map((r: Result) => [r.name, r.status])),
    };
  }

  it("starts a step once what it needs has passed", async () => {
    const { together, results } = await run([make("a"), make("b", { needs: ["a"] }), make("c")]);
    expect(together.slice(0, 2)).toEqual([["a"], ["a", "c"]]);
    expect(together.find((t) => t.includes("b"))).not.toContain("a");
    expect(results).toEqual({ a: "passed", b: "passed", c: "passed" });
  });

  it("runs one lane's steps one at a time, and no more than the cores hold", async () => {
    const lane = await run([
      make("a", { lane: "valkey" }),
      make("b", { lane: "valkey" }),
      make("c"),
    ]);
    expect(lane.together.some((t) => t.includes("a") && t.includes("b"))).toBe(false);
    const order = await run(
      [
        make("hog", { memory: 9 }),
        make("big", { lane: "valkey", memory: 6 }),
        make("small", { lane: "valkey" }),
      ],
      room,
    );
    expect(order.together.findIndex((t) => t.includes("big"))).toBeLessThan(
      order.together.findIndex((t) => t.includes("small")),
    );
    const serial = await run([make("a"), make("b"), make("c")], { ...room, cores: 1 });
    expect(serial.together.every((t) => t.length === 1)).toBe(true);
    const cores = await run([
      make("wide", { cores: 6 }),
      make("also wide", { cores: 6 }),
      make("thin"),
    ]);
    expect(cores.together.some((t) => t.includes("wide") && t.includes("also wide"))).toBe(false);
    expect(cores.together.some((t) => t.includes("wide") && t.includes("thin"))).toBe(true);
  });

  it("keeps to the memory, and Docker's, but always runs a step on its own", async () => {
    const memory = await run([
      make("big", { memory: 20 }),
      make("x", { memory: 6 }),
      make("y", { memory: 6 }),
    ]);
    expect(memory.together.every((t) => t.length === 1 || !t.includes("big"))).toBe(true);
    expect(memory.together.some((t) => t.includes("x") && t.includes("y"))).toBe(false);
    const docker = await run([
      make("p", { docker: 1.5 }),
      make("q", { docker: 1 }),
      make("r", { docker: 0.25 }),
    ]);
    expect(docker.together.some((t) => t.includes("p") && t.includes("q"))).toBe(false);
    expect(docker.together.some((t) => t.includes("p") && t.includes("r"))).toBe(true);
  });

  it("stops everything at the first failure, but lets a kept step finish", async () => {
    const { results, aborted } = await run(
      [
        make("fails"),
        make("slow"),
        make("slow kept", { keep: true }),
        make("after", { needs: ["fails"] }),
      ],
      room,
      ["fails", "slow"],
    );
    expect(results).toEqual({
      fails: "failed",
      slow: "stopped",
      "slow kept": "passed",
      after: "stopped",
    });
    expect(aborted).toEqual(["slow"]);
  });

  it("reports what it skipped, and stops when nothing can start", async () => {
    const { results } = await run(
      [make("a", { needs: ["nowhere"] }), make("b")],
      room,
      [],
      new Map([["b", "area untouched (app)"]]),
    );
    expect(results).toEqual({ a: "stopped", b: "skipped" });
  });
});

describe("the commands a step runs", () => {
  it("keeps their output, quiet or not, and their exit code", async () => {
    const logged: string[] = [];
    const exec = spawnExec(new AbortController().signal, (text) => logged.push(text));
    expect(await exec("sh", ["-c", "echo out; echo err >&2; exit 3"])).toEqual({
      status: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
    expect((await exec("sh", ["-c", "echo $X"], { env: { X: "set" }, quiet: true })).stdout).toBe(
      "set\n",
    );
    expect(logged.join("")).toBe("out\nerr\n");
  });

  it("says when a command doesn't exist", async () => {
    const exec = spawnExec(new AbortController().signal, () => undefined);
    const ran = await exec("no-such-command-anywhere", [], { cwd: tmpdir() });
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("no-such-command-anywhere");
  });

  it("stops the command and what it started when the step is stopped", async () => {
    const controller = new AbortController();
    const exec = spawnExec(controller.signal, () => undefined);
    const started = Date.now();
    const ran = exec("sh", ["-c", "sleep 20 & sleep 20"]);
    setTimeout(() => controller.abort(), 50);
    // Killed by the signal (no status) or exiting on it, depending on how the shell
    // handles SIGTERM: never a success, and long before the sleeps' 20 seconds.
    expect((await ran).status).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    controller.abort();
  });
});

describe("the hook", () => {
  /** A machine where the push changes `files` since abc; `answer` for everything else. */
  function machine(
    files: string[],
    answer: (line: string) => Partial<Ran> | undefined = () => undefined,
    git: Record<string, string> = {},
  ) {
    const answers: [RegExp, Partial<Ran>][] = [
      [/^git merge-base/, { stdout: "abc\n" }],
      [/^git diff --name-only/, { stdout: files.join("\n") }],
      [/^docker info/, { stdout: String(4 * GB) }],
      [/^docker stats/, { stdout: "postgres\t512MiB / 1GiB\n" }],
      [/^git (\S+)/, {}],
    ];
    const fake = fakeRun((line) => {
      const [, found] = answers.find(([pattern]) => pattern.test(line)) ?? [];
      const word = /^git (\S+)/.exec(line)?.[1] ?? "";
      return answer(line) ?? (found && { ...found, stdout: found.stdout ?? git[word] ?? "" });
    });
    const given = {
      run: fake.run,
      exec:
        (_signal: AbortSignal, log: (text: string) => void) =>
        async (command: string, args: string[]) => {
          log(`${command} ran\n`);
          return fake.run(command, args);
        },
      clamd: async () => ({ url: "tcp://127.0.0.1:9", close: async () => undefined }),
      cpus: 4,
      memory: 16 * GB,
      env: {},
      onInterrupt: () => undefined,
    };
    return { given, calls: fake.calls };
  }

  it("runs every step the push's areas call for, and sums them up", async () => {
    const output = captureOutput();
    const { given, calls } = machine(["apps/api/src/main.ts"], undefined, {
      log: "fix(api): a thing\n",
    });
    expect(await prePush(given)).toBe(0);
    expect(calls).toContain("bun run lint");
    expect(calls).toContain("bun scripts/push-coverage.ts --concurrency=3");
    expect(calls).toContain("bun run codeql --languages javascript-typescript");
    expect(calls.some((c) => c.startsWith("bun run charts:check"))).toBe(false);
    expect(output()).toContain(
      "Pre-push: 1 files changed since abc, 3 cores and 14 GB for the steps",
    );
    expect(output()).toMatch(/charts {2,}skipped {2,}area untouched \(charts\)/);
    expect(output()).toContain(`ci.yml:images`);
    expect(output()).toContain("every check CI runs that can run here passed");
  });

  it("names the step that failed, prints its output, and warns about uncommitted changes", async () => {
    const output = captureOutput();
    const { given } = machine(
      ["README.md"],
      (l) => (l === "bun run lint" ? { status: 1 } : undefined),
      {
        status: " M README.md\n",
      },
    );
    expect(await prePush(given)).toBe(1);
    expect(output()).toContain("Uncommitted changes");
    expect(output()).toContain("bun ran");
    expect(output()).toContain("lint failed: fix it, or push with --no-verify");
  });

  it("refuses a step that needs more Docker memory than there is", async () => {
    const output = captureOutput();
    const { given } = machine(["README.md"], (l) =>
      l.startsWith("docker info") ? { status: 1, stdout: "" } : undefined,
    );
    expect(await prePush({ ...given, env: { PRE_PUSH_SKIP: "secrets" } })).toBe(1);
    expect(output()).toContain(
      "known vulnerabilities needs 0.5 GB of Docker memory, and Docker has 0.0 GB free",
    );
  });

  it("stops everything when interrupted", async () => {
    captureOutput();
    const { given } = machine(["README.md"]);
    let stop = () => undefined as unknown;
    const exec =
      (signal: AbortSignal, log: (text: string) => void) =>
      async (command: string, args: string[]) => {
        stop();
        return signal.aborted
          ? { status: null, stdout: "", stderr: "" }
          : given.exec(signal, log)(command, args);
      };
    const onInterrupt = (handler: () => void) => {
      stop = handler;
    };
    expect(await prePush({ ...given, exec, onInterrupt })).toBe(130);
  });

  it("reports a step that throws as failed", async () => {
    const output = captureOutput();
    const { given } = machine(["README.md"]);
    const exec = () => async () => {
      throw new Error("spawn exploded");
    };
    expect(await prePush({ ...given, exec })).toBe(1);
    expect(output()).toContain("spawn exploded");
  });

  it("stops when git can't tell what the push changes", async () => {
    const output = captureOutput();
    const { given } = machine([], (l) =>
      l.startsWith("git diff --name-only") ? { status: 128, stderr: "bad base" } : undefined,
    );
    expect(await prePush(given)).toBe(1);
    expect(output()).toContain("git diff against abc failed: bad base");
  });

  it("listens for Ctrl-C", () => {
    const stop = () => undefined;
    MACHINE.onInterrupt(stop);
    expect(process.listeners("SIGINT")).toContain(stop);
    process.removeListener("SIGINT", stop);
  });
});
