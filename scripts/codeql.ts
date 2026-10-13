/**
 * CodeQL, as the Security workflow runs it, on this machine: `bun run codeql`, or
 * `bun run codeql --languages python,actions` for some of the languages. The languages
 * and the query suite are read from security.yml's CodeQL job; the code is what CI would
 * check out (every file git tracks or would, as it is on disk, nothing it ignores). It
 * fails on what the master ruleset blocks a merge on: a security alert of high severity
 * or above, or any alert of error level, each printed as `file:line rule message`.
 *
 * Uses a `codeql` on the PATH when it's this version, else the CodeQL bundle at this
 * version (the one security.yml's github/codeql-action pin uses: its src/defaults.json),
 * downloaded once into ~/.cache/boilerplate/codeql and checked against its SHA-256. The
 * CLI's license allows it on public repositories; a private one needs GitHub Advanced
 * Security (docs/testing.md).
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod";
import { errno, fail, ok, ROOT, type Run, runMain, runSync, warn } from "./lib";

// The CodeQL bundle's checksums are per platform: update them with the version.
// renovate: datasource=github-releases depName=github/codeql-cli-binaries
export const CODEQL_VERSION = "v2.27.1";
const BUNDLES: Partial<Record<NodeJS.Platform, { name: string; sha256: string }>> = {
  darwin: {
    name: "codeql-bundle-osx64.tar.gz",
    sha256: "bca7fe16689986793b8bbc75cf1e0809497b9baed7f10cde42f403eca1390c0a",
  },
  linux: {
    name: "codeql-bundle-linux64.tar.gz",
    sha256: "1d380f79896ededc654c7b21fafb3360136f1aeb678ad4df4df9af3910c6b815",
  },
};

/** What the scan touches; the real ones by default, stand-ins in the tests. */
export type Deps = {
  run?: Run;
  root?: string;
  cache?: string;
  platform?: NodeJS.Platform;
  bundles?: typeof BUNDLES;
};

const securityWorkflow = z.object({
  jobs: z.object({
    codeql: z.object({
      strategy: z.object({ matrix: z.object({ language: z.array(z.string()) }) }),
      steps: z.array(
        z.object({
          uses: z.string().optional(),
          with: z.object({ queries: z.string().optional() }).optional(),
        }),
      ),
    }),
  }),
});

/** The languages and query suite security.yml's CodeQL job scans with. */
export function ciScan(root = ROOT) {
  const workflow = securityWorkflow.parse(
    Bun.YAML.parse(readFileSync(join(root, ".github/workflows/security.yml"), "utf8")),
  );
  const job = workflow.jobs.codeql;
  const init = job.steps.find((step) => step.uses?.startsWith("github/codeql-action/init@"));
  return { languages: job.strategy.matrix.language, queries: init?.with?.queries ?? "default" };
}

/** A file's SHA-256, read in pieces (the bundle is over a gigabyte). */
export async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(file).stream()) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** The CodeQL CLI to run: a local one of this version, else the bundle, fetched once. */
export async function cli(deps: Required<Deps>): Promise<string | undefined> {
  const { run, cache, platform, bundles } = deps;
  if (run("codeql", ["version", "--format=terse"]).stdout.trim() === CODEQL_VERSION.slice(1)) {
    return "codeql";
  }
  const home = join(cache, CODEQL_VERSION);
  const binary = join(home, "codeql", "codeql");
  if (run(binary, ["version", "--format=terse"]).status === 0) {
    return binary;
  }
  const bundle = bundles[platform];
  if (!bundle) {
    fail(`No CodeQL bundle for ${platform}: install the CodeQL CLI ${CODEQL_VERSION} yourself`);
    return undefined;
  }
  mkdirSync(cache, { recursive: true });
  const part = mkdtempSync(join(cache, "download-"));
  try {
    const archive = join(part, bundle.name);
    const url = `https://github.com/github/codeql-action/releases/download/codeql-bundle-${CODEQL_VERSION}/${bundle.name}`;
    warn(`Downloading the CodeQL bundle ${CODEQL_VERSION} (about a gigabyte, once)`);
    if (
      run("curl", ["-fsSL", "--retry", "3", "-o", archive, url], { stdio: "inherit" }).status !== 0
    ) {
      fail(`Couldn't download ${url}`);
      return undefined;
    }
    if ((await sha256(archive)) !== bundle.sha256) {
      fail(`${bundle.name} doesn't match its SHA-256 in scripts/codeql.ts: not using it`);
      return undefined;
    }
    if (run("tar", ["-xzf", archive, "-C", part]).status !== 0) {
      fail(`Couldn't unpack ${bundle.name}`);
      return undefined;
    }
    mkdirSync(home, { recursive: true });
    renameSync(join(part, "codeql"), join(home, "codeql"));
    return binary;
  } finally {
    rmSync(part, { recursive: true, force: true });
  }
}

/** Copies what CI would check out (tracked and untracked files git doesn't ignore). */
export function sourceTree(run: Run, root: string, to: string) {
  const files = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
  }).stdout.split("\0");
  for (const file of files.filter(Boolean)) {
    try {
      mkdirSync(dirname(join(to, file)), { recursive: true });
      cpSync(join(root, file), join(to, file), { verbatimSymlinks: true });
    } catch (error) {
      // Deleted on disk but still in the index: not in what's pushed either.
      if (!errno(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

const rule = z.object({
  id: z.string(),
  defaultConfiguration: z.object({ level: z.string().optional() }).optional(),
  properties: z.object({ "security-severity": z.string().optional() }).optional(),
});
const rules = z.object({ rules: z.array(rule).optional() });
/** The parts of a SARIF report the findings need. */
const sarifReport = z.object({
  runs: z.array(
    z.object({
      tool: z.object({ driver: rules, extensions: z.array(rules).optional() }),
      results: z.array(
        z.object({
          ruleId: z.string(),
          level: z.string().optional(),
          message: z.object({ text: z.string() }),
          locations: z
            .array(
              z.object({
                physicalLocation: z
                  .object({
                    artifactLocation: z.object({ uri: z.string().optional() }).optional(),
                    region: z.object({ startLine: z.number().optional() }).optional(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        }),
      ),
    }),
  ),
});
type Sarif = z.infer<typeof sarifReport>;

/** Where one run works: its scratch directory, the copied source, CI's query suite. */
type Scan = { work: string; source: string; queries: string };

/** A SARIF report's findings, and which of them the master ruleset blocks a merge on. */
export function findings(sarif: Sarif) {
  return sarif.runs.flatMap((sarifRun) => {
    const { driver, extensions = [] } = sarifRun.tool;
    const rules = new Map(
      [driver, ...extensions].flatMap((part) => part.rules ?? []).map((rule) => [rule.id, rule]),
    );
    return sarifRun.results.map((result) => {
      const rule = rules.get(result.ruleId);
      const level = result.level ?? rule?.defaultConfiguration?.level ?? "warning";
      const severity = Number(rule?.properties?.["security-severity"] ?? 0);
      const where = result.locations?.[0]?.physicalLocation;
      const line = `${where?.artifactLocation?.uri}:${where?.region?.startLine}`;
      return {
        text: `${line} ${result.ruleId} ${result.message.text.split("\n")[0]}`,
        blocks: severity >= 7 || level === "error",
      };
    });
  });
}

/** One language: a database of `source`, the suite run over it; its findings. */
function analyze(run: Run, codeql: string, language: string, scan: Scan) {
  const pack = language === "javascript-typescript" ? "javascript" : language;
  const database = join(scan.work, `db-${language}`);
  const sarif = join(scan.work, `${language}.sarif`);
  // Half the machine's memory (CodeQL's own default is under 2 GB, which slows it down).
  const resources = ["--threads=0", `--ram=${Math.floor(totalmem() / 2 ** 21)}`];
  const suite = `codeql/${pack}-queries:codeql-suites/${pack}-${scan.queries}.qls`;
  const create = ["database", "create", database, `--language=${language}`, "--build-mode=none"];
  const steps = [
    [...create, `--source-root=${scan.source}`, ...resources],
    [
      "database",
      "analyze",
      database,
      suite,
      "--format=sarif-latest",
      `--output=${sarif}`,
      ...resources,
    ],
  ];
  for (const args of steps) {
    const step = run(codeql, args);
    if (step.status !== 0) {
      process.stderr.write(`${step.stdout}${step.stderr}`);
      return undefined;
    }
  }
  return findings(sarifReport.parse(JSON.parse(readFileSync(sarif, "utf8"))));
}

/** Scans `languages` (security.yml's, by default); the exit code. */
export async function codeql(languages?: string[], deps: Deps = {}): Promise<number> {
  const all: Required<Deps> = {
    run: runSync,
    root: ROOT,
    cache: join(homedir(), ".cache/boilerplate/codeql"),
    platform: process.platform,
    bundles: BUNDLES,
    ...deps,
  };
  const ci = ciScan(all.root);
  const chosen = languages ?? ci.languages;
  const unknown = chosen.filter((language) => !ci.languages.includes(language));
  if (unknown.length > 0) {
    fail(`Not a language CI scans: ${unknown.join(", ")} (it scans ${ci.languages.join(", ")})`);
    return 1;
  }
  const binary = await cli(all);
  if (!binary) {
    return 1;
  }
  const work = mkdtempSync(join(tmpdir(), "codeql-"));
  try {
    const source = join(work, "source");
    sourceTree(all.run, all.root, source);
    let blocked = 0;
    for (const language of chosen) {
      const began = performance.now();
      const found = analyze(all.run, binary, language, { work, source, queries: ci.queries });
      const took = `${Math.round((performance.now() - began) / 1000)}s`;
      if (!found) {
        fail(`CodeQL couldn't analyze ${language} (its output is above)`);
        return 1;
      }
      const blocking = found.filter((finding) => finding.blocks);
      for (const finding of blocking) {
        console.error(`  ${finding.text}`);
      }
      blocked += blocking.length;
      const below = found.length - blocking.length;
      const note = below > 0 ? `, and ${below} below the ruleset's threshold` : "";
      (blocking.length > 0 ? fail : ok)(
        `${language}: ${blocking.length} blocking${note} (${took})`,
      );
    }
    return blocked > 0 ? 1 : 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The command: `bun run codeql [--languages a,b]`; the exit code. */
export function main(argv = process.argv.slice(2), deps: Deps = {}) {
  const { values } = parseArgs({ args: argv, options: { languages: { type: "string" } } });
  return codeql(values.languages?.split(",").filter(Boolean), deps);
}

await runMain(import.meta, main);
