/**
 * Misconfigurations in the infrastructure code (Dockerfiles, Kubernetes manifests, Helm
 * charts, OpenTofu): `bun scripts/misconfig.ts`, the Security workflow's "Infrastructure
 * misconfigurations" job (which passes `--format sarif --output <file>`, handed on to
 * Trivy), and the pre-commit hook when a staged file is one it reads.
 *
 * First it renders every chart of ours the way `bun run charts:check` does (the
 * application charts for every environment and optional feature, the platform's with a
 * cluster's values; scripts/charts.ts) into deploy/.rendered: Trivy can't render them
 * itself, since they need values a cluster or environment sets, and it skipped them.
 * Then Trivy's `config` scan of the whole repository with trivy.yaml (its checks, the
 * reviewed findings in .trivyignore.yaml, the trusted registries), at CI's Trivy version:
 * a local trivy of that version, else its image in Docker; with neither, or without helm,
 * it fails and says how to get one, rather than skipping the scan. The whole repository,
 * not only the staged files: Trivy names a file scanned on its own by its bare name, so
 * the ignore file's paths wouldn't match, and the scan takes a few seconds.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  addonCharts,
  applicationRenders,
  argocdChart,
  platformRenders,
  type RemoteChart,
  remoteRender,
} from "./charts";
import { fail, ROOT, type Run, runMain, runSync } from "./lib";

/** Where the rendered charts go for the scan (git ignores it). */
export const RENDERED = "deploy/.rendered";

// renovate: datasource=docker depName=aquasec/trivy
export const TRIVY_VERSION = "0.74.0";

/** Whether the scan reads `path` (a path from the repository root). */
export const misconfigReads = (path: string) =>
  /(^|\/)[^/]*Dockerfile$/.test(path) ||
  /^(deploy|infra)\//.test(path) ||
  path === "scripts/charts.ts" ||
  path === "trivy.yaml" ||
  path === ".trivyignore.yaml";

/**
 * Kinds scanned on their own, each in a pass of its own (RENDERED/isolated/<kind>). Once
 * a scan includes one of these, Trivy runs its check for that kind (a complete LimitRange,
 * a ResourceQuota with CPU and memory) on every manifest it scans, and reports each
 * Deployment and Service as an incomplete LimitRange. Alone, each is checked as itself.
 */
export const ISOLATED_KINDS = ["LimitRange", "ResourceQuota"];

/** Writes a render's documents: the isolated kinds apart, the rest to `<name>.yaml`. */
function writeRender(dir: string, name: string, manifests: string) {
  const rest: string[] = [];
  for (const doc of manifests.split(/^---$/m)) {
    const kind = /^kind: (\w+)$/m.exec(doc)?.[1] ?? "";
    if (ISOLATED_KINDS.includes(kind)) {
      mkdirSync(join(dir, "isolated", kind), { recursive: true });
      appendFileSync(join(dir, "isolated", kind, `${name}.yaml`), `---${doc}`);
    } else {
      rest.push(doc);
    }
  }
  writeFileSync(join(dir, `${name}.yaml`), rest.join("---"));
}

/** Where pulled charts are kept, one file per chart and version: pulled once. */
export const CHART_CACHE = join(homedir(), ".cache/boilerplate/charts");

/**
 * A remote chart's local copy, `<cache>/<name>-<version>.tgz`, pulled when it isn't
 * there yet; undefined (with helm's output shown) when the pull fails.
 */
export function pulledChart(run: Run, remote: RemoteChart, cache: string) {
  const file = join(cache, `${remote.name}-${remote.version}.tgz`);
  if (existsSync(file)) {
    return file;
  }
  mkdirSync(cache, { recursive: true });
  const part = mkdtempSync(join(cache, "pull-"));
  try {
    const args = ["pull", ...remote.source, "--version", remote.version, "--destination", part];
    const pulled = run("helm", args);
    const archive = readdirSync(part).find((name) => name.endsWith(".tgz"));
    if (pulled.status !== 0 || !archive) {
      process.stderr.write(pulled.stderr);
      return undefined;
    }
    renameSync(join(part, archive), file);
    return file;
  } finally {
    rmSync(part, { recursive: true, force: true });
  }
}

/** The renders: ours from their folders, the add-ons and Argo CD's from cached pulls. */
function renders(run: Run, root: string, charts: string) {
  const remote = [...addonCharts(root), argocdChart(root)].flatMap((chart) =>
    chart ? [chart] : [],
  );
  const pulled = remote.map((chart) => {
    const file = pulledChart(run, chart, charts);
    // Helm's test pods, which Argo CD never runs, left out.
    const args = file ? [...remoteRender(chart, [file]), "--skip-tests"] : undefined;
    return { name: `addon-${chart.name}`, args };
  });
  return [...applicationRenders(root), ...platformRenders(root), ...pulled];
}

/** Renders every chart we deploy into RENDERED; whether all of them rendered. */
export function renderCharts(run: Run, root: string, charts = CHART_CACHE): boolean {
  const dir = join(root, RENDERED);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const { name, args } of renders(run, root, charts)) {
    if (!args) {
      fail(`helm couldn't pull the chart for ${name} (above)`);
      return false;
    }
    const rendered = run("helm", args, { cwd: root });
    if (rendered.status === null) {
      fail("helm isn't installed: install it (https://helm.sh/docs/intro/install/)");
      return false;
    }
    if (rendered.status !== 0) {
      process.stderr.write(rendered.stderr);
      fail(`helm couldn't render ${name} (above)`);
      return false;
    }
    writeRender(dir, name, rendered.stdout);
  }
  return true;
}

/** How Trivy runs here: a local one of CI's version, else its image; none, undefined. */
function trivyWith(run: Run, root: string, cache: string, passphrase: string) {
  if (run("trivy", ["--version"], { cwd: root }).stdout.includes(`Version: ${TRIVY_VERSION}\n`)) {
    return (args: string[]): [string, string[]] => ["trivy", [...args, "--cache-dir", cache]];
  }
  if (run("docker", ["info"], { cwd: root, stdio: "ignore" }).status === 0) {
    const image = [
      "run",
      "--rm",
      "--memory=512m",
      // Writable: an --output file lands in the checkout.
      "-v",
      `${root}:${root}`,
      "-w",
      root,
      "-e",
      `TF_VAR_state_passphrase=${passphrase}`,
      `aquasec/trivy:${TRIVY_VERSION}`,
    ];
    return (args: string[]): [string, string[]] => ["docker", [...image, ...args]];
  }
  return undefined;
}

/**
 * Scans the repository at `root`; the exit code (1 on any finding, from trivy.yaml).
 * `argv` goes to the main pass, which CI reports from (SARIF); the isolated kinds' passes
 * print their findings, and fail the same way.
 */
export function misconfig(
  argv = process.argv.slice(2),
  run = runSync,
  root = ROOT,
  // Its own cache, which never holds a downloaded checks bundle (trivy.yaml skips the
  // update), so it uses the checks built into this version, as CI's fresh runner does.
  cache = join(homedir(), ".cache/boilerplate/trivy"),
  charts = CHART_CACHE,
): number {
  if (!renderCharts(run, root, charts)) {
    return 1;
  }
  // OpenTofu's only variable without a value in the example tfvars (trivy.yaml): a
  // secret, which nothing the scan checks depends on.
  const passphrase = "scanned-not-applied";
  const trivy = trivyWith(run, root, cache, passphrase);
  if (!trivy) {
    fail(
      `Trivy ${TRIVY_VERSION} isn't installed and Docker isn't running: install that version (https://github.com/aquasecurity/trivy/releases) or start Docker`,
    );
    return 1;
  }
  const isolated = join(root, RENDERED, "isolated");
  const passes = [
    ["config", "--quiet", ...argv, "."],
    ...ISOLATED_KINDS.filter((kind) => existsSync(join(isolated, kind))).map((kind) => [
      "config",
      "--quiet",
      join(RENDERED, "isolated", kind),
    ]),
  ];
  const env = { ...process.env, TF_VAR_state_passphrase: passphrase };
  let status = 0;
  for (const pass of passes) {
    const [command, args] = trivy(pass);
    const scanned = run(command, args, { cwd: root, stdio: "inherit", env }).status ?? 1;
    status = Math.max(status, scanned);
  }
  return status;
}

await runMain(import.meta, misconfig);
