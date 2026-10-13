/**
 * The OpenTofu root's examples: every environment with a tfvars example has a backend
 * example of its own, with a state key of its own, so nobody copies staging's and points
 * production at staging's state.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { infraCheck } from "./infra";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const ROOT_DIR = join(import.meta.dir, "../infra/tofu/envs/k3s");
const environments = readdirSync(ROOT_DIR)
  .map((file) => /^(\w+)\.tfvars\.example$/.exec(file)?.[1])
  .filter((env): env is string => env !== undefined);

describe("infra/tofu/envs/k3s", () => {
  it("has tfvars examples", () => {
    expect(environments.sort()).toEqual(["production", "staging"]);
  });

  it.each(environments)("has a backend example for %s, with its own state key", (env) => {
    const backend = readFileSync(join(ROOT_DIR, `backend-${env}.hcl.example`), "utf8");
    expect(backend).toContain(`key        = "boilerplate/${env}.tfstate"`);
  });
});

describe("the facts OpenTofu writes on the cluster", () => {
  const main = readFileSync(join(ROOT_DIR, "main.tf"), "utf8");
  const block = /cluster_annotations = merge\(([\s\S]*?)\n {2}\)/.exec(main)?.[1] ?? "";
  const keys = [...block.matchAll(/"?([a-z][a-z0-9-]*)"?\s*=\s*(?:var|tostring|local|"|\w)/g)]
    .map((m) => m[1] as string)
    .filter((key) => !["var", "local"].includes(key));
  const readers = [
    ...readdirSync(join(import.meta.dir, "../deploy/argocd/appsets")).map(
      (f) => `deploy/argocd/appsets/${f}`,
    ),
    ...readdirSync(join(import.meta.dir, "../deploy/platform/addons"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => `deploy/platform/addons/${f}`),
  ]
    .map((file) => readFileSync(join(import.meta.dir, "..", file), "utf8"))
    .join("\n");

  it("writes annotations", () => {
    expect(keys).toContain("domain");
  });

  it.each(keys)("boilerplate.dev/%s is read by an ApplicationSet or an add-on", (key) => {
    const read =
      readers.includes(`boilerplate.dev/${key}`) ||
      new RegExp(`:\\s*${key}(\\|\\S*)?\\s*$`, "m").test(readers);
    expect(read).toBe(true);
  });
});

describe("the DNS provider's modules", () => {
  // Each is counted on dns.provider; Cloudflare's state from before that had no index.
  it("keep an existing environment's Cloudflare resources where they are", () => {
    const main = readFileSync(join(ROOT_DIR, "main.tf"), "utf8");
    expect(main).toContain("moved {\n  from = module.cloudflare\n  to   = module.cloudflare[0]\n}");
    expect(main).toMatch(/module "cloudflare" \{\n\s+count\s+= local\.cloudflare \? 1 : 0/);
  });
});

describe("the OpenTofu check", () => {
  const TOFU = join(import.meta.dir, "../infra/tofu");
  const pluginCache = () => join(mkdtempSync(join(tmpdir(), "tofu-plugins-")), "cache");

  it("checks the format, then inits, validates and tests every root with the plugin cache", () => {
    const printed = captureOutput();
    const { run, calls, options } = fakeRun();
    const cache = pluginCache();
    expect(infraCheck({ run, tofuDir: TOFU, pluginCache: cache, env: { PATH: "/bin" } })).toBe(0);
    const roots = [
      "envs/k3s",
      "modules/bootstrap",
      "modules/cloudflare",
      "modules/k3s",
      "modules/rfc2136",
    ];
    expect(calls).toEqual([
      "tofu fmt -check -recursive -diff .",
      ...roots.flatMap(() => [
        "tofu init -backend=false -input=false -no-color",
        "tofu validate -no-color",
        "tofu test -no-color",
      ]),
    ]);
    expect(options.map((o) => o.cwd)).toEqual([
      TOFU,
      ...roots.flatMap((root) => Array(3).fill(join(TOFU, root))),
    ]);
    expect(options[0]?.env).toEqual({
      PATH: "/bin",
      TF_PLUGIN_CACHE_DIR: cache,
      TF_IN_AUTOMATION: "1",
    });
    expect(readdirSync(cache)).toEqual([]);
    expect(printed()).toContain("modules/k3s: tests");
  });

  it("fails with tofu's output, and skips what an init that failed can't check", () => {
    const printed = captureOutput();
    const tofuDir = mkdtempSync(join(tmpdir(), "tofu-"));
    for (const root of ["modules/broken", "modules/plain", "envs/one/tests"]) {
      mkdirSync(join(tofuDir, root), { recursive: true });
    }
    const { run, calls, options } = fakeRun((line) =>
      line.startsWith("tofu fmt")
        ? { status: 3, stdout: "main.tf\n", stderr: "badly formatted\n" }
        : {},
    );
    const broken = join(tofuDir, "modules/broken");
    const code = infraCheck({
      run: (command, args, given) => {
        const ran = run(command, args, given);
        const fails = given?.cwd === broken && args[0] === "init";
        return fails ? { status: 1, stdout: "", stderr: "no provider" } : ran;
      },
      tofuDir,
      pluginCache: pluginCache(),
    });
    expect(code).toBe(1);
    expect(printed()).toContain("main.tf\nbadly formatted");
    expect(printed()).toContain("no provider");
    expect(calls).toEqual([
      "tofu fmt -check -recursive -diff .",
      "tofu init -backend=false -input=false -no-color",
      "tofu validate -no-color",
      "tofu test -no-color",
      "tofu init -backend=false -input=false -no-color",
      "tofu init -backend=false -input=false -no-color",
      "tofu validate -no-color",
    ]);
    expect(options.map((o) => o.cwd)).toEqual([
      tofuDir,
      ...Array(3).fill(join(tofuDir, "envs/one")),
      broken,
      ...Array(2).fill(join(tofuDir, "modules/plain")),
    ]);
  });
});
