/**
 * Checks the OpenTofu code the way CI does: `bun run infra:check`.
 *
 *   1. `tofu fmt -check` over infra/tofu;
 *   2. every module and environment root: init (no backend), validate, and its tests
 *      (`tofu test`, against mocked providers: nothing is created or connected to).
 *
 * Needs `tofu` (the version CI pins in .github/workflows/ci.yml, or the devcontainer).
 * Providers are downloaded once into the plugin cache.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT, runMain, runSync } from "./lib";

const TOFU = join(ROOT, "infra/tofu");
const PLUGIN_CACHE = join(ROOT, "node_modules/.cache/tofu-plugins");

/** Checks every root under `tofuDir` with tofu; the exit code. */
export function infraCheck({
  run = runSync,
  tofuDir = TOFU,
  pluginCache = PLUGIN_CACHE,
  env = process.env,
} = {}): number {
  mkdirSync(pluginCache, { recursive: true });
  const tofu = (args: string[], cwd: string) => {
    const result = run("tofu", args, {
      cwd,
      env: { ...env, TF_PLUGIN_CACHE_DIR: pluginCache, TF_IN_AUTOMATION: "1" },
    });
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
  };

  let failed = false;
  const check = (label: string, result: { ok: boolean; output: string }) => {
    if (result.ok) {
      ok(label);
      return true;
    }
    failed = true;
    fail(label);
    console.error(result.output.trim());
    return false;
  };

  check("tofu fmt", tofu(["fmt", "-check", "-recursive", "-diff", "."], tofuDir));

  const roots = [
    ...readdirSync(join(tofuDir, "modules")).map((name) => `modules/${name}`),
    ...readdirSync(join(tofuDir, "envs")).map((name) => `envs/${name}`),
  ];
  for (const root of roots.sort()) {
    const dir = join(tofuDir, root);
    if (
      !check(`${root}: init`, tofu(["init", "-backend=false", "-input=false", "-no-color"], dir))
    ) {
      continue;
    }
    check(`${root}: validate`, tofu(["validate", "-no-color"], dir));
    if (existsSync(join(dir, "tests"))) {
      check(`${root}: tests`, tofu(["test", "-no-color"], dir));
    }
  }

  return failed ? 1 : 0;
}

await runMain(import.meta, infraCheck);
