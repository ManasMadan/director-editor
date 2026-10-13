/**
 * What the workflows in .github/workflows promise, read from the files themselves: who
 * gets which secrets, what runs when, and the rules every job follows (.claude/rules/ci.md).
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  environment?: string;
  env?: Record<string, string>;
  steps?: Step[];
  "timeout-minutes"?: number;
  uses?: string;
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

function workflow(name: string) {
  return Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows", name), "utf8")) as Workflow;
}

describe("infra.yml", () => {
  const { jobs } = workflow("infra.yml");
  const plan = jobs.plan as Job;
  const apply = jobs.apply as Job;

  it("plans pull requests in an environment of their own, never the apply one", () => {
    expect(plan.environment).toMatch(/^infra-\$\{\{ matrix\.env \}\}-plan$/);
    expect(plan.if).toContain("github.event_name == 'pull_request'");
    expect(apply.environment).toMatch(/^infra-\$\{\{ matrix\.env \}\}$/);
    expect(apply.if).toBe("github.event_name == 'workflow_dispatch'");
  });

  it("gives a pull request's plan no SSH key and no age keys", () => {
    const text = JSON.stringify(plan);
    for (const secret of ["SSH_PRIVATE_KEY", "SOPS_AGE_KEY", "SOPS_PREVIEW_AGE_KEY"]) {
      expect(text).not.toContain(`secrets.${secret}`);
    }
  });

  it("never plans a fork's pull request", () => {
    expect(plan.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("plans without taking the state lock, which read-only bucket keys can't", () => {
    const step = plan.steps?.find((s) => s.name === "Plan");
    expect(step?.run).toContain("-lock=false");
  });

  describe("the nightly drift check", () => {
    const { on } = workflow("infra.yml");
    const drift = jobs.drift as Job & { permissions?: Record<string, string> };
    const step = drift?.steps?.find((s) => s.name === "Plan");

    /** The Plan step's outputs when `tofu plan` prints `printed` and exits `code`. */
    function planned(printed: string, code: number) {
      const dir = mkdtempSync(join(tmpdir(), "drift-"));
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "bin/tofu"), `#!/bin/sh\nprintf '${printed}'\nexit ${code}\n`, {
        mode: 0o755,
      });
      const output = join(dir, "output");
      writeFileSync(output, "");
      Bun.spawnSync(["bash", "-eo", "pipefail", "-c", step?.run ?? ""], {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, GITHUB_OUTPUT: output },
      });
      return readFileSync(output, "utf8");
    }

    it("runs every night, and only then, in an environment without reviewers or apply keys", () => {
      expect(on.schedule).toEqual([{ cron: "17 3 * * *" }]);
      expect(drift?.if).toBe(
        "github.event_name == 'schedule' && needs.targets.outputs.matrix != '[]'",
      );
      expect(drift?.environment).toBe(`infra-\${{ matrix.env }}-drift`);
      expect(drift?.permissions).toEqual({ contents: "read", issues: "write" });
      const text = JSON.stringify(drift);
      for (const secret of ["SSH_PRIVATE_KEY", "SOPS_AGE_KEY", "SOPS_PREVIEW_AGE_KEY"]) {
        expect(text).not.toContain(`secrets.${secret}`);
      }
      expect(step?.run).toContain("-lock=false -detailed-exitcode");
    });

    it("tells drift (2) from a clean plan (0) and a failed one, with the plan's summary", () => {
      expect(planned("Plan: 1 to add, 0 to change, 0 to destroy.\\n", 2)).toBe(
        "status=2\nsummary=Plan: 1 to add, 0 to change, 0 to destroy.\n",
      );
      expect(planned("No changes.\\n", 0)).toBe("status=0\nsummary=\n");
      expect(planned("Error: no state\\n", 1)).toStartWith("status=1\n");
    });

    it("keeps an issue open while it drifts, closes it once a plan is clean, and fails on drift", () => {
      const issue = drift?.steps?.find((s) => s.uses === "./.github/actions/issue");
      expect(issue?.if).toBe(
        "steps.plan.outputs.status == '0' || steps.plan.outputs.status == '2'",
      );
      expect(issue?.with?.title).toBe(`Infrastructure drift: \${{ matrix.env }}`);
      expect(issue?.with?.body).toContain("steps.plan.outputs.status == '2' && format(");
      expect(drift?.steps?.at(-1)).toMatchObject({
        if: "steps.plan.outputs.status != '0'",
        run: "exit 1",
      });
    });
  });
});

describe("every workflow", () => {
  const files = readdirSync(join(ROOT, ".github/workflows")).filter((f) => f.endsWith(".yml"));

  it("starts every job with harden-runner", () => {
    const missing = files.flatMap((file) =>
      Object.entries(workflow(file).jobs)
        .filter(([, job]) => !job.steps?.[0]?.uses?.startsWith("step-security/harden-runner@"))
        .map(([name]) => `${file}: ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it("audits every job's egress, or blocks all but the endpoints it lists", () => {
    const wrong = files.flatMap((file) =>
      Object.entries(workflow(file).jobs).flatMap(([name, job]) => {
        const options = job.steps?.[0]?.with ?? {};
        const policy = options["egress-policy"];
        const endpoints = String(options["allowed-endpoints"] ?? "")
          .split(/\s+/)
          .filter(Boolean);
        if (policy === "audit" && endpoints.length === 0) {
          return [];
        }
        if (policy === "block" && endpoints.every((e) => /^[\w*.-]+:\d+$/.test(e))) {
          return [];
        }
        return [`${file}: ${name}`];
      }),
    );
    expect(wrong).toEqual([]);
  });

  it("gives a job that blocks egress what the setup action downloads from", () => {
    const blocking = files.flatMap((file) =>
      Object.values(workflow(file).jobs).filter(
        (job) => job.steps?.[0]?.with?.["egress-policy"] === "block",
      ),
    );
    expect(blocking.length).toBeGreaterThan(0);
    for (const job of blocking) {
      const endpoints = String(job.steps?.[0]?.with?.["allowed-endpoints"]).split(/\s+/);
      if (job.steps?.some((step) => step.uses === "./.github/actions/setup")) {
        expect(endpoints).toEqual(
          expect.arrayContaining([
            "github.com:443",
            "registry.npmjs.org:443",
            "*.blob.core.windows.net:443",
          ]),
        );
      }
    }
  });

  it("blocks egress where the traffic is known: the area check, the title check, ci-ok", () => {
    const { jobs } = workflow("ci.yml");
    for (const name of ["changes", "pr-title", "ci-ok"]) {
      expect({ name, policy: jobs[name]?.steps?.[0]?.with?.["egress-policy"] }).toEqual({
        name,
        policy: "block",
      });
    }
  });

  it("never leaves a checkout's token in .git/config: a job that pushes passes it to the push", () => {
    const persisting = files.flatMap((file) =>
      Object.entries(workflow(file).jobs).flatMap(([name, job]) =>
        (job.steps ?? [])
          .filter((step) => step.uses?.startsWith("actions/checkout@"))
          .filter((step) => step.with?.["persist-credentials"] !== false)
          .map(() => `${file}: ${name}`),
      ),
    );
    expect(persisting).toEqual([]);
  });

  it("caches nothing a release could pick up from an earlier run", () => {
    const steps = workflow("release.yml").jobs.release?.steps ?? [];
    expect(steps.some((step) => step.uses?.startsWith("actions/cache@"))).toBe(false);
    const bun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    expect(bun?.with?.["no-cache"]).toBe(true);
  });

  it("pins every action by commit, with its version beside it", () => {
    const unpinned = files.flatMap((file) =>
      readFileSync(join(ROOT, ".github/workflows", file), "utf8")
        .split("\n")
        .filter((line) => /^\s*(- )?uses: (?!\.\/)/.test(line))
        .filter((line) => !/@[0-9a-f]{40} # v?\d\S*$/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(unpinned).toEqual([]);
  });

  it("checks out a workflow_run's commit only for this repository's own pushes", () => {
    // workflow_run runs with secrets whatever triggered the run it follows, a fork's pull
    // request included: checking that run's commit out must be limited to ours.
    const guard = [
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_repository.full_name == github.repository",
    ];
    const unguarded = files
      .filter((file) => "workflow_run" in workflow(file).on)
      .flatMap((file) =>
        Object.entries(workflow(file).jobs)
          .filter(([, job]) =>
            job.steps?.some(
              (step) =>
                step.uses?.startsWith("actions/checkout@") &&
                /\$\{\{/.test(String(step.with?.ref ?? "")),
            ),
          )
          .filter(([, job]) => !guard.every((check) => job.if?.includes(check)))
          .map(([name]) => `${file}: ${name}`),
      );
    expect(unguarded).toEqual([]);
  });

  it("gives every job a timeout, so a hung one doesn't burn six hours", () => {
    const missing = files.flatMap((file) =>
      Object.entries(workflow(file).jobs)
        .filter(([, job]) => job["timeout-minutes"] === undefined)
        .map(([name]) => `${file}: ${name}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("claude-review.yml", () => {
  const { on, jobs } = workflow("claude-review.yml");
  const review = jobs.review as Job & { permissions?: Record<string, string> };
  const action = review.steps?.find((step) =>
    step.uses?.startsWith("anthropics/claude-code-action@"),
  );
  const args = String(action?.with?.claude_args);

  it("reviews only the repository's own pull requests, once it has opted in", () => {
    expect(Object.keys(on)).toEqual(["pull_request"]);
    expect(review.if).toContain("vars.CLAUDE_REVIEW == 'true'");
    expect(review.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  it("can comment and nothing else", () => {
    expect(review.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    expect(args).toContain("--permission-mode dontAsk");
    expect(args).toMatch(/--max-turns \d+/);
    const tools = /--allowedTools "([^"]+)"/.exec(args)?.[1]?.split(",") ?? [];
    expect(tools).toContain("Agent");
    for (const tool of tools) {
      expect(tool).toMatch(
        /^(Read|Glob|Grep|Agent|Bash\((git (diff|log|show)|gh pr (comment|diff|view)) \*\))$/,
      );
    }
  });

  it("asks for the repository's own reviewer agents", () => {
    for (const agent of ["reviewer", "security-reviewer", "migration-reviewer"]) {
      expect(String(action?.with?.prompt)).toContain(`\`${agent}\``);
      expect(readdirSync(join(ROOT, ".claude/agents"))).toContain(`${agent}.md`);
    }
  });
});

describe("deploy.yml", () => {
  const { jobs } = workflow("deploy.yml");
  const merge = jobs.publish?.steps?.find((step) => step.name === "Merge the architectures");

  it("signs with the key pair when there is one, so admission needn't trust Sigstore", () => {
    expect(merge?.run).toContain(
      "cosign sign --yes --key env://COSIGN_PRIVATE_KEY --tlog-upload=false",
    );
    expect(JSON.stringify(merge)).toContain("secrets.COSIGN_PRIVATE_KEY");
  });

  it("signs keylessly otherwise", () => {
    expect(merge?.run).toContain('cosign sign --yes "$REGISTRY/$image@$digest"');
  });

  describe("every image docker-bake.hcl builds", () => {
    const bake = readFileSync(join(ROOT, "docker-bake.hcl"), "utf8");
    const targets = JSON.parse(
      /group "default" \{\s*targets = (\[[^\]]*\])/.exec(bake)?.[1] ?? "[]",
    ) as string[];
    const { env } = workflow("deploy.yml") as Workflow & { env: Record<string, string> };
    type Matrix = Job & { strategy: { matrix: Record<string, string[]> } };
    const build = jobs.build as Matrix;
    const attest = jobs.attest as Matrix | undefined;
    const steps = attest?.steps ?? [];
    const using = (action: string) => steps.filter((s) => s.uses?.startsWith(`${action}@`));

    it("is built, merged and signed", () => {
      expect(targets.length).toBe(7);
      expect(build.strategy.matrix.image).toEqual(targets);
      // The merge-and-sign loop runs over $IMAGES, and hands each digest on to attest.
      expect(env.IMAGES?.split(" ")).toEqual(targets);
      expect(merge?.run).toContain("for image in $IMAGES; do");
      const outputs = (jobs.publish as Job & { outputs: Record<string, string> }).outputs;
      for (const image of targets) {
        expect(outputs[image]).toBe(`\${{ steps.merge.outputs.${image} }}`);
      }
    });

    it("gets build provenance on its multi-arch digest", () => {
      expect(attest?.strategy.matrix.image).toEqual(targets);
      expect(attest?.needs).toBe("publish");
      expect(using("actions/attest-build-provenance").map((s) => s.with)).toEqual([
        {
          "subject-name": `\${{ env.REGISTRY }}/\${{ matrix.image }}`,
          "subject-digest": `\${{ needs.publish.outputs[matrix.image] }}`,
          "push-to-registry": true,
        },
      ]);
    });

    it("gets an SBOM for each platform it's built for, attested to that platform's digest", () => {
      const arches = build.strategy.matrix.arch ?? [];
      expect(arches).toEqual(["amd64", "arm64"]);
      const find = steps.find((s) => s.name === "Find each platform's digest");
      expect(find?.run).toContain(`for arch in ${arches.join(" ")}; do`);
      const sboms = using("anchore/sbom-action");
      const attested = using("actions/attest-sbom");
      expect(sboms.length).toBe(arches.length);
      expect(attested.length).toBe(arches.length);
      for (const [i, arch] of arches.entries()) {
        const digest = `\${{ steps.digests.outputs.${arch} }}`;
        expect(sboms[i]?.with?.image).toBe(`\${{ env.REGISTRY }}/\${{ matrix.image }}@${digest}`);
        expect(attested[i]?.with).toEqual({
          "subject-name": `\${{ env.REGISTRY }}/\${{ matrix.image }}`,
          "subject-digest": digest,
          "sbom-path": sboms[i]?.with?.["output-file"],
          "push-to-registry": true,
        });
      }
    });

    it("reaches staging only once it's attested", () => {
      expect(jobs.staging?.needs).toEqual(["publish", "attest"]);
    });
  });
});

describe("the GitHub-only parts", () => {
  const table = readFileSync(join(ROOT, "docs/deploy.md"), "utf8");
  const workflows = readdirSync(join(ROOT, ".github/workflows"))
    .map((file) => readFileSync(join(ROOT, ".github/workflows", file), "utf8"))
    .join("\n");
  const previews = readFileSync(join(ROOT, "deploy/argocd/appsets/previews.yaml"), "utf8");

  // What each is called in the workflows, and in docs/deploy.md's table.
  const parts: [used: string, documented: string][] = [
    ["workflow_run:", "`workflow_run`"],
    ["merge_group:", "`merge_group`"],
    ["id-token: write", "OIDC keyless signing"],
    ["actions/attest-build-provenance", "`attest-build-provenance`"],
    ["github/codeql-action", "CodeQL"],
    ["actions/dependency-review-action", "dependency review"],
    ["ghcr.io", "GHCR"],
    ["actions/create-github-app-token", "the GitHub App"],
    ["anthropics/claude-code-action", "`claude-code-action`"],
  ];

  it("are each in docs/deploy.md with what replaces them", () => {
    for (const [used, documented] of parts) {
      if (workflows.includes(used)) {
        expect({ used, documented: table.includes(documented) }).toEqual({
          used,
          documented: true,
        });
      }
    }
    if (previews.includes("github:")) {
      expect(table).toContain("`pullRequest.github`");
    }
  });
});

describe("the merge queue", () => {
  // The checks the ruleset requires come from these (docs/repository-settings.md).
  it.each(["ci.yml", "security.yml"])("runs %s, so its required checks report there", (file) => {
    expect(Object.keys(workflow(file).on)).toContain("merge_group");
  });

  it("skips what the pull request's own run already did, which counts as passing", () => {
    const { jobs } = workflow("security.yml");
    expect(jobs.secrets?.if).toBe("github.event_name != 'merge_group'");
    expect(jobs.dependencies?.if).toBe("github.event_name == 'pull_request'");
    expect(jobs.osv?.if).toBeUndefined();
  });
});

describe("ci.yml's codegen check", () => {
  const step = workflow("ci.yml").jobs.codegen?.steps?.find(
    (s) => s.name === "Fail if generation changed or added files",
  );

  it("fails on new generated files too, not only on changed ones", () => {
    expect(step?.run).toContain('[[ -n "$(git status --porcelain)" ]]');
    expect(step?.run).not.toContain("git diff --exit-code");
  });
});

describe("deploy.yml's staging bump", () => {
  const { jobs } = workflow("deploy.yml");
  const script = jobs.staging?.steps?.find((s) => s.name === "Point staging at the new images")
    ?.run as string;

  /** A master with commits a (staging's), b and c, pushed to a local origin. */
  function repository() {
    const dir = mkdtempSync(join(tmpdir(), "staging-bump-"));
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: join(dir, "work") })
        .stdout.toString()
        .trim();
    Bun.spawnSync(["git", "init", "--bare", "-b", "master", join(dir, "origin")]);
    Bun.spawnSync(["git", "clone", join(dir, "origin"), join(dir, "work")]);
    git("config", "user.email", "ci@example.com");
    git("config", "user.name", "CI");
    const commit = (message: string) => {
      git("commit", "--allow-empty", "-qm", message);
      return git("rev-parse", "HEAD");
    };
    mkdirSync(join(dir, "work/deploy/environments/staging"), { recursive: true });
    const a = commit("a");
    writeFileSync(
      join(dir, "work/deploy/environments/staging/stack.yaml"),
      `image:\n  tag: "sha-${a}"\n`,
    );
    git("add", ".");
    const b = commit("b");
    const c = commit("c");
    git("push", "-q", "origin", "master");
    const bump = (tag: string) =>
      Bun.spawnSync(["bash", "-c", script], {
        cwd: join(dir, "work"),
        env: { ...process.env, TAG: tag },
      });
    const staging = () =>
      Bun.spawnSync([
        "git",
        "--git-dir",
        join(dir, "origin"),
        "show",
        "master:deploy/environments/staging/stack.yaml",
      ]).stdout.toString();
    return { a, b, c, bump, staging };
  }

  // Each of these runs a dozen git commands: slow on a busy machine, so they get time.
  const GIT = 30_000;

  it(
    "moves staging forward to a newer commit's images",
    () => {
      const repo = repository();
      expect(repo.bump(`sha-${repo.c}`).exitCode).toBe(0);
      expect(repo.staging()).toContain(`tag: "sha-${repo.c}"`);
    },
    GIT,
  );

  it(
    "never moves it back when an older commit's run finishes last",
    () => {
      const repo = repository();
      repo.bump(`sha-${repo.c}`);
      const late = repo.bump(`sha-${repo.b}`);
      expect(late.exitCode).toBe(0);
      expect(late.stdout.toString()).toContain("newer than");
      expect(repo.staging()).toContain(`tag: "sha-${repo.c}"`);
    },
    GIT,
  );

  it("builds every commit's images: one run per commit, never cancelled", () => {
    const text = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");
    expect(text).toContain(
      `group: deploy-\${{ github.event.workflow_run.head_sha || github.sha }}`,
    );
  });
});

describe("ci.yml's path filters", () => {
  const { jobs } = workflow("ci.yml");
  const run = jobs["ci-ok"]?.steps?.find((step) => step.name === "Require every job to succeed")
    ?.run as string;
  const program = /jq -e --arg event "\$EVENT" '([\s\S]*)' > \/dev\/null/.exec(run)?.[1] ?? "";
  const gates = JSON.parse(
    (/\{([^}]*)\} as \$gates/.exec(program)?.[1] ?? "")
      .replace(/([\w-]+):/g, '"$1":')
      .replace(/""/g, '"')
      .replace(/^/, "{")
      .concat("}"),
  ) as Record<string, string[]>;

  /** What ci-ok decides for these job results and areas. */
  function passes(event: string, areas: Record<string, string>, results: Record<string, string>) {
    const needs = {
      changes: { result: "success", outputs: areas },
      ...Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result }])),
    };
    return (
      Bun.spawnSync(["jq", "-e", "--arg", "event", event, program], {
        stdin: new TextEncoder().encode(JSON.stringify(needs)),
      }).exitCode === 0
    );
  }
  const areas = (on: string[]) =>
    Object.fromEntries(
      ["app", "charts", "infra", "images", "scripts"].map((a) => [a, String(on.includes(a))]),
    );
  const skipped = (names: string[]) => Object.fromEntries(names.map((n) => [n, "skipped"]));
  const heavy = Object.keys(gates);

  it("gates each job on the areas ci-ok lets it skip for", () => {
    expect(heavy.length).toBeGreaterThan(10);
    for (const [job, needed] of Object.entries(gates)) {
      const condition = jobs[job]?.if ?? "";
      for (const area of needed) {
        expect(condition).toContain(`needs.changes.outputs.${area} == 'true'`);
      }
    }
  });

  it("passes a pull request touching no area that ran only lint and the title check", () => {
    expect(
      passes("pull_request", areas([]), {
        lint: "success",
        "pr-title": "success",
        ...skipped(heavy),
      }),
    ).toBe(true);
  });

  it("passes a chart change that skipped the app's suites", () => {
    const ran = { lint: "success", "pr-title": "success", charts: "success", unit: "success" };
    const rest = skipped(heavy.filter((job) => !(job in ran)));
    expect(passes("pull_request", areas(["charts", "scripts"]), { ...rest, ...ran })).toBe(true);
  });

  it("fails an app change whose suites were skipped anyway", () => {
    expect(
      passes("pull_request", areas(["app"]), {
        lint: "success",
        "pr-title": "success",
        ...skipped(heavy),
      }),
    ).toBe(false);
  });

  it("fails when a job failed, or the changes job itself did", () => {
    expect(passes("pull_request", areas([]), { lint: "failure", ...skipped(heavy) })).toBe(false);
    const needs = { changes: { result: "failure", outputs: {} } };
    const result = Bun.spawnSync(["jq", "-e", "--arg", "event", "pull_request", program], {
      stdin: new TextEncoder().encode(JSON.stringify(needs)),
    });
    expect(result.exitCode).not.toBe(0);
  });
});

describe("ci.yml's end-to-end job", () => {
  it("turns the captcha on with Cloudflare's always-pass test keys, so its valid path runs", () => {
    const env = workflow("ci.yml").jobs.e2e?.env ?? {};
    expect(env.TURNSTILE_SITE_KEY).toBe("1x00000000000000000000AA");
    expect(env.TURNSTILE_SECRET_KEY).toBe("1x0000000000000000000000000000000AA");
  });

  it("has a second shard, which fuzzes the API (scripts/e2e.ts), with uv for Schemathesis", () => {
    const e2e = workflow("ci.yml").jobs.e2e;
    expect(JSON.stringify(e2e)).toContain('"matrix":{"shard":[1,2,3,4]}');
    expect(e2e?.steps?.find((s) => s.uses === "./.github/actions/setup")?.with).toEqual({
      python: "true",
    });
    expect(e2e?.steps?.map((s) => s.run)).toContain(
      `bun run test:e2e --shard=\${{ matrix.shard }}/4`,
    );
  });
});

describe("jobs that run turbo", () => {
  // Turbo's tasks depend on `^gen`, which reaches the Python service's own `gen` (uv)
  // through the AI client, whatever --filter says: a job without uv fails there.
  const turbo = /\bturbo\b|bun run (test|check-types|lint|gen|build)\b|test:e2e|generators\.ts/;

  it("all get uv from the shared setup action", () => {
    const missing = Object.entries(workflow("ci.yml").jobs).flatMap(([name, job]) => {
      const runs = (job.steps ?? []).some((step) => turbo.test(step.run ?? ""));
      const setup = job.steps?.find((step) => step.uses === "./.github/actions/setup");
      return runs && setup?.with?.python !== "true" ? [name] : [];
    });
    expect(missing).toEqual([]);
  });
});

describe("jobs that migrate the database", () => {
  // Bun doesn't load .env by itself, and CI has none: Prisma reads the migrator's URL
  // from the step's or the job's environment, or migrate deploy fails without it.
  it("give the migrator's URL to every step that applies or checks migrations", () => {
    const missing = Object.entries(workflow("ci.yml").jobs).flatMap(([name, job]) =>
      (job.steps ?? [])
        .filter((step) => /\bdb:deploy\b|\bbun run drift\b/.test(step.run ?? ""))
        .filter((step) => !(step.env?.MIGRATOR_DATABASE_URL ?? job.env?.MIGRATOR_DATABASE_URL))
        .map((step) => `${name}: ${step.name ?? step.run}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("preview.yml's cleanup", () => {
  const { jobs } = workflow("preview.yml");
  const script = jobs.cleanup?.steps?.[1]?.with?.script as string;

  /** Runs the step's script against a fake GitHub with these package versions. */
  async function cleanup(versions: { id: number; tags: string[] }[]) {
    const deleted: number[] = [];
    const endpoint = (name: string) => Object.assign(async () => ({}), { endpoint: name });
    const github = {
      paginate: async (fn: { endpoint: string }) =>
        fn.endpoint === "commits"
          ? [{ sha: "aaa" }, { sha: "bbb" }]
          : versions.map((v) => ({ id: v.id, metadata: { container: { tags: v.tags } } })),
      rest: {
        pulls: { listCommits: endpoint("commits") },
        packages: {
          getAllPackageVersionsForPackageOwnedByUser: endpoint("versions"),
          getAllPackageVersionsForPackageOwnedByOrg: endpoint("versions"),
          deletePackageVersionForUser: async (r: { package_version_id: number }) => {
            deleted.push(r.package_version_id);
          },
          deletePackageVersionForOrg: async () => undefined,
        },
      },
    };
    const context = {
      repo: { owner: "me", repo: "boilerplate" },
      payload: {
        pull_request: { number: 7 },
        repository: { owner: { login: "me", type: "User" } },
      },
    };
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
    process.env.IMAGES = "api";
    await new AsyncFunction("github", "context", "core", script)(github, context, {
      info: () => undefined,
    });
    return deleted;
  }

  it("runs when a pull request with a preview closes, and only then builds nothing", () => {
    expect(jobs.cleanup?.if).toContain("github.event.action == 'closed'");
    expect(jobs.images?.if).toContain("github.event.action != 'closed'");
  });

  it("deletes the images of the pull request's commits, and nothing else", async () => {
    const deleted = await cleanup([
      { id: 1, tags: ["sha-aaa"] },
      { id: 2, tags: ["sha-bbb"] },
      { id: 3, tags: ["sha-ccc"] },
      { id: 4, tags: ["sha-aaa", "v1.0.0"] },
      { id: 5, tags: [] },
    ]);
    expect(deleted).toEqual([1, 2]);
  });
});

describe("CI's caches", () => {
  const ci = workflow("ci.yml");
  const setup = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github/actions/setup/action.yml"), "utf8"),
  ) as {
    runs: { steps: Step[] };
  };
  const cached = (steps: Step[] = []) =>
    steps.filter((step) => step.uses?.startsWith("actions/cache@")).map((step) => step.with?.path);

  it("keeps Bun's downloads, and a uv cache per job so the jobs don't race to save one", () => {
    expect(cached(setup.runs.steps)).toContain("~/.bun/install/cache");
    const uv = setup.runs.steps.find((step) => step.uses?.startsWith("astral-sh/setup-uv@"));
    expect(uv?.with?.["cache-suffix"]).toBe(`\${{ github.job }}`);
  });

  it("keeps the browsers, Next's build cache and Trivy's database", () => {
    expect(cached(ci.jobs.components?.steps)).toContain("~/.cache/ms-playwright");
    expect(cached(ci.jobs.e2e?.steps)).toEqual(
      expect.arrayContaining(["~/.cache/ms-playwright", "apps/web/.next/cache"]),
    );
    expect(cached(ci.jobs.images?.steps)).toContain("~/.cache/trivy");
  });

  it("keeps ClamAV's signatures where compose's ClamAV reads them", () => {
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).toContain(`"\${CLAMAV_DATA:-clamav}:/var/lib/clamav"`);
    for (const job of ["integration", "e2e"]) {
      const steps = ci.jobs[job]?.steps ?? [];
      expect(cached(steps)).toContain("~/.cache/clamav");
      const day = steps.find((step) => step.name === "The day, for the signatures' cache key");
      expect(day?.run).toContain('echo "CLAMAV_DATA=$HOME/.cache/clamav" >> "$GITHUB_ENV"');
      // Restored before ClamAV starts, or it downloads them anyway.
      const cache = steps.findIndex((step) => step.with?.path === "~/.cache/clamav");
      const start = steps.findIndex(
        (step) => step.name === "Start object storage and virus scanning",
      );
      expect(cache).toBeLessThan(start);
    }
  });

  it("keeps each package's incremental type-check state, where tsc writes it", () => {
    const base = readFileSync(join(ROOT, "packages/typescript-config/base.json"), "utf8");
    expect(base).toContain('"incremental": true');
    expect(base).toContain(`"tsBuildInfoFile": "\${configDir}/node_modules/.cache/tsc/`);
    const paths = String(cached(ci.jobs.types?.steps)[0]).split("\n").filter(Boolean);
    for (const dir of [
      "apps/*",
      "packages/*",
      "load",
      "scripts",
      ".claude/hooks",
      "turbo/generators",
    ]) {
      expect(paths).toContain(`${dir}/node_modules/.cache/tsc`);
    }
  });

  it("builds the component library's Storybook through turbo, whose cache CI keeps", () => {
    const ui = JSON.parse(readFileSync(join(ROOT, "packages/ui/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(ui.scripts["test:visual"]).toStartWith("turbo run build-storybook --filter=@repo/ui");
    const turbo = readFileSync(join(ROOT, "turbo.json"), "utf8");
    expect(turbo).toMatch(/"build-storybook": \{\s*"outputs": \["storybook-static\/\*\*"\]/);
  });

  it("writes master's image layers where deploy.yml's amd64 build reads them, and no pull request's", () => {
    const bake = ci.jobs.images?.steps?.find((step) =>
      step.uses?.startsWith("docker/bake-action@"),
    );
    const set = String(bake?.with?.set);
    expect(set).toContain(
      `\${{ github.event_name == 'push' && format('*.cache-to=type=gha,mode=max,scope={0}-amd64', matrix.image) || '' }}`,
    );
    const deploy = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");
    expect(deploy).toContain(
      `*.cache-from=type=gha,scope=\${{ matrix.image }}-\${{ matrix.arch }}`,
    );
    expect(deploy).toContain(`RELEASE: \${{ env.SHA }}`);
  });
});

describe("ci.yml's images job", () => {
  const images = workflow("ci.yml").jobs.images as Job & {
    strategy: { matrix: { image: string[] } };
  };

  it("starts every image it builds and checks it answers", async () => {
    const { IMAGES } = await import("./image-smoke");
    expect(images.strategy.matrix.image.sort()).toEqual(Object.keys(IMAGES).sort());
    const steps = images.steps ?? [];
    const scan = steps.findIndex((step) => step.name === "Scan the image");
    const smoke = steps.findIndex((step) => step.name === "Smoke-test the image");
    expect(steps[smoke]?.run).toBe(`bun scripts/image-smoke.ts \${{ matrix.image }}`);
    expect(smoke).toBeGreaterThan(scan);
  });
});

describe("the mobile app's release", () => {
  const { jobs } = workflow("mobile.yml");
  const eas = jobs.eas as Job;

  it("checks the native dependencies against the Expo SDK in lint, which CI's lint job runs", async () => {
    const mobile = JSON.parse(readFileSync(join(ROOT, "apps/mobile/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(mobile.scripts.lint).toBe("expo-doctor && expo install --check");
    const { STEPS } = await import("./lint");
    expect(STEPS).toContainEqual(["bunx", "turbo", "run", "lint"]);
    expect(workflow("ci.yml").jobs.lint?.steps?.map((s) => s.run)).toContain("bun run lint");
  });

  it("waits for the store builds and their submissions, so a failed one fails the run", () => {
    const store = eas.steps?.find((s) => s.name === "Store builds, submitted for review");
    expect(store?.run).toContain("eas build ");
    expect(store?.run).toContain(" --wait");
    expect(store?.run).not.toContain("--no-wait");
    expect(String(eas["timeout-minutes"])).toBe(
      `\${{ github.event.workflow_run.name == 'Release' && 150 || 30 }}`,
    );
  });
});

describe("the issue action", () => {
  const action = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github/actions/issue/action.yml"), "utf8"),
  ) as { runs: { steps: Step[] } };
  const step = action.runs.steps[0];
  const script = step?.with?.script as string;

  /** Runs the action's script against a fake GitHub with these open issues. */
  async function issue(
    body: string,
    open: { number: number; title: string; pull_request?: object }[],
  ) {
    const calls: [string, Record<string, unknown>][] = [];
    const record =
      (name: string, data: Record<string, unknown> = {}) =>
      async (request: Record<string, unknown>) => {
        calls.push([name, request]);
        return { data };
      };
    const listForRepo = Object.assign(async () => ({}), { endpoint: "list" });
    const github = {
      paginate: async (fn: unknown, request: Record<string, unknown>) => {
        expect(fn).toBe(listForRepo);
        expect(request).toMatchObject({ state: "open" });
        return open;
      },
      rest: {
        issues: {
          listForRepo,
          create: record("create", { number: 9 }),
          update: record("update"),
          createComment: record("comment"),
        },
      },
    };
    const context = { repo: { owner: "me", repo: "boilerplate" } };
    Object.assign(process.env, { TITLE: "Uptime: down", BODY: body, RUN: "https://run/1" });
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
    await new AsyncFunction("github", "context", "core", script)(github, context, {
      info: () => undefined,
    });
    return calls;
  }
  const repo = { owner: "me", repo: "boilerplate" };

  it("passes the title and body as environment variables, never into the script", () => {
    expect(step?.uses).toStartWith("actions/github-script@");
    expect(step?.env).toMatchObject({ TITLE: `\${{ inputs.title }}`, BODY: `\${{ inputs.body }}` });
    expect(script).not.toContain("${{");
  });

  it("opens an issue when something goes wrong", async () => {
    const pull = { number: 3, title: "Uptime: down", pull_request: {} };
    expect(await issue("site down", [pull])).toEqual([
      [
        "create",
        { ...repo, title: "Uptime: down", body: "site down\n\nLast checked: https://run/1" },
      ],
    ]);
  });

  it("keeps the open one current while it stays wrong, without a new issue", async () => {
    expect(await issue("mail down", [{ number: 4, title: "Uptime: down" }])).toEqual([
      ["update", { ...repo, issue_number: 4, body: "mail down\n\nLast checked: https://run/1" }],
    ]);
  });

  it("closes it, saying so, once it's fixed", async () => {
    expect(await issue("", [{ number: 4, title: "Uptime: down" }])).toEqual([
      ["comment", { ...repo, issue_number: 4, body: "Fixed, as of https://run/1" }],
      ["update", { ...repo, issue_number: 4, state: "closed", state_reason: "completed" }],
    ]);
  });

  it("does nothing when all is well and nothing is open", async () => {
    expect(await issue("", [{ number: 5, title: "Something else" }])).toEqual([]);
  });
});

describe("uptime.yml", () => {
  const { on, jobs } = workflow("uptime.yml");
  const probe = jobs.probe as Job & { permissions: Record<string, string> };
  const steps = probe.steps ?? [];

  it("probes every environment from outside the clusters on a schedule", () => {
    expect(Object.keys(on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(on.schedule).toEqual([{ cron: "*/30 * * * *" }]);
    expect(steps.find((s) => s.id === "probe")?.run).toContain("bun scripts/uptime.ts");
    expect(probe.permissions).toEqual({ contents: "read", issues: "write" });
  });

  it("keeps an issue open with what's down, and fails while anything is", () => {
    const issue = steps.find((s) => s.uses === "./.github/actions/issue");
    expect(issue?.with).toEqual({
      title: "Uptime: an environment is down",
      body: `\${{ steps.probe.outputs.report }}`,
    });
    const last = steps.at(-1);
    expect(last).toMatchObject({ if: "steps.probe.outputs.status != '0'", run: "exit 1" });
  });
});

describe("stripe.yml", () => {
  const { on, jobs } = workflow("stripe.yml");
  const steps = jobs.contract?.steps ?? [];

  it("runs the fake's contract against Stripe weekly, with the key on that step alone", () => {
    expect(Object.keys(on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const test = steps.find((step) => step.run === "bunx vitest run src/contract.test.ts");
    expect(test?.env).toEqual({
      STRIPE_CONTRACT_SECRET_KEY: `\${{ secrets.STRIPE_CONTRACT_SECRET_KEY }}`,
    });
    expect(readFileSync(join(ROOT, "packages/fake-stripe/src/contract.test.ts"), "utf8")).toContain(
      "process.env.STRIPE_CONTRACT_SECRET_KEY",
    );
  });

  it("passes without the key, doing nothing but saying so", () => {
    const after = steps.slice(2);
    expect(after.length).toBeGreaterThan(0);
    for (const step of after) {
      expect(step.if).toBe("steps.key.outputs.present == 'true'");
    }
    expect(steps[1]?.run).toContain("::notice::STRIPE_CONTRACT_SECRET_KEY isn't set");
  });

  it("is documented with its secret", () => {
    expect(readFileSync(join(ROOT, "docs/repository-settings.md"), "utf8")).toContain(
      "`STRIPE_CONTRACT_SECRET_KEY`",
    );
  });
});

describe("tools CI downloads", () => {
  it("are checked against a pinned checksum, never installed unverified", () => {
    const dir = join(ROOT, ".github/workflows");
    const text = readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8"));
    expect(text.filter((workflow) => workflow.includes("--verify=false"))).toEqual([]);
    const step = workflow("ci.yml").jobs.charts?.steps?.find(
      (s) => s.name === "Install helm-unittest",
    );
    expect(step?.env?.SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(step?.run).toContain('echo "$SHA256  unittest.tgz" | sha256sum -c -');
  });
});

describe("ci.yml's unit job", () => {
  it("runs the packages' unit tests only for the app, so docs alone run only the scripts'", () => {
    const steps = workflow("ci.yml").jobs.unit?.steps ?? [];
    expect(steps.find((step) => step.run === "bun run test")?.if).toBe(
      "needs.changes.outputs.app == 'true'",
    );
  });

  it("holds the scripts and hooks to 100% on its own, since a change to them alone skips the coverage job", () => {
    const steps = workflow("ci.yml").jobs.unit?.steps ?? [];
    expect(steps.map((step) => step.run ?? "")).toContain(
      "bun test --coverage ./scripts/ ./.claude/hooks/ && bun scripts/coverage.ts --bun",
    );
  });
});

describe("the checks a merge waits for", () => {
  /** Each workflow that can block a pull request, and the one gate it reports. */
  const GATES: Record<string, string> = {
    "ci.yml": "CI passed",
    "security.yml": "Security passed",
    "kind.yml": "Kubernetes passed",
    "infra.yml": "Infrastructure passed",
  };
  /** Jobs a gate leaves out on purpose: the nightly evals call real model providers. */
  const NOT_GATED: Record<string, string[]> = { "ci.yml": ["evals"] };
  /** Runs on pull requests but never blocks one: optional, or started by a label. */
  const ADVISORY = ["claude-review.yml", "preview.yml"];
  const onPullRequests = readdirSync(join(ROOT, ".github/workflows")).filter(
    (file) => file.endsWith(".yml") && "pull_request" in workflow(file).on,
  );

  it("come from one gate per workflow that needs every other job and always reports", () => {
    expect(onPullRequests.filter((file) => !ADVISORY.includes(file)).sort()).toEqual(
      Object.keys(GATES).sort(),
    );
    for (const [file, name] of Object.entries(GATES)) {
      const { on, jobs } = workflow(file);
      const [key, gate] = Object.entries(jobs).find(([, job]) => job.name === name) ?? [];
      expect({ file, gate: Boolean(gate) }).toEqual({ file, gate: true });
      expect({ file, if: gate?.if }).toEqual({ file, if: "always()" });
      const others = Object.keys(jobs).filter(
        (job) => job !== key && !(NOT_GATED[file] ?? []).includes(job),
      );
      expect({ file, needs: [gate?.needs ?? []].flat().sort() }).toEqual({
        file,
        needs: others.sort(),
      });
      // A path filter would leave the gate unreported on other pull requests, and a
      // queued pull request waits for it in the merge queue.
      expect({ file, filtered: JSON.stringify(on.pull_request ?? {}).includes("paths") }).toEqual({
        file,
        filtered: false,
      });
      expect({ file, queue: "merge_group" in on }).toEqual({ file, queue: true });
    }
  });

  it("are the gates and nothing else in the master ruleset", () => {
    const settings = readFileSync(join(ROOT, "docs/repository-settings.md"), "utf8");
    const required = [...settings.matchAll(/\{"context": "([^"]+)"\}/g)].map(([, name]) => name);
    expect(required.sort()).toEqual(Object.values(GATES).sort());
  });
});

describe("a job acting as the GitHub App", () => {
  // Until the App is set up, its token step fails: such a job is skipped instead, so a
  // fresh copy of the template keeps master's runs green (the staging bump did fail).
  it("is skipped while BOT_APP_CLIENT_ID isn't set", () => {
    const files = readdirSync(join(ROOT, ".github/workflows")).filter((f) => f.endsWith(".yml"));
    const unguarded = files.flatMap((file) =>
      Object.entries(workflow(file).jobs)
        .filter(([, job]) =>
          (job.steps ?? []).some(
            (step) =>
              step.uses === "./.github/actions/bot" ||
              step.uses?.startsWith("actions/create-github-app-token@"),
          ),
        )
        .filter(([, job]) => !String(job.if ?? "").includes("vars.BOT_APP_CLIENT_ID != ''"))
        .map(([id]) => `${file}:${id}`),
    );
    expect(unguarded).toEqual([]);
  });
});
