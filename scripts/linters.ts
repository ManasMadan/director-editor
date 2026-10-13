/**
 * The linters that don't come from npm, each at a pinned version: `bun scripts/linters.ts
 * <name>` (or `bun run lint:<name>`) runs one over every file git tracks or would that it
 * reads. `bun run lint` runs them all, so CI's lint job does, and the pre-commit hook runs
 * those that read a staged file.
 *
 *   actionlint   the workflows, and shellcheck on their `run:` blocks
 *   zizmor       the workflows' and actions' security (.github/zizmor.yml), offline
 *   shellcheck   every shell script: *.sh, the git hooks, and any file whose first line
 *                runs a shell (a .shellcheckrc beside scripts without one says which)
 *   hadolint     every Dockerfile
 *   tflint       the OpenTofu code (infra/tofu/.tflint.hcl)
 *   renovate     renovate.json5, by Renovate's config validator in strict mode (it also
 *                fails on settings Renovate would migrate), at the version renovate.yml
 *                runs Renovate at; and no other config file Renovate would read first
 *
 * Each uses a local binary of its version, else its image in Docker; with neither, it
 * fails and says how to get one, rather than skipping the check.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT, type Run, runMain, runSync } from "./lib";

type Linter = {
  /** Its command, when not its name. */
  binary?: string;
  /** Its image, without the tag. */
  image: string;
  /** The image's tag: the version CI runs. */
  version: string;
  /** Where its releases are, to install that version. */
  releases: string;
  /** Whether it checks `path` (from the repository root `root`). */
  reads: (path: string, root: string) => boolean;
  /** Its arguments, given the files it checks and the repository root. */
  args: (files: string[], root: string) => string[];
  /** Why the files it reads can't be checked as they are, if they can't. */
  refuses?: (files: string[]) => string | undefined;
};

/** Renovate reads the first of these it finds, ahead of renovate.json5. */
const OTHER_RENOVATE_CONFIGS = [
  "renovate.json",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
  ".gitlab/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.json5",
];

/**
 * A shell script: a .sh file, a git hook, or a file without an extension whose first line
 * runs a shell shellcheck reads.
 */
export function isShellScript(path: string, root: string): boolean {
  if (/\.(sh|bash)$/.test(path) || /^\.husky\/[^/.][^/]*$/.test(path)) {
    return true;
  }
  const file = join(root, path);
  return (
    /(^|\/)[^/.]+$/.test(path) &&
    existsSync(file) &&
    /^#!\s*\S*\b(env\s+)?(sh|bash|dash|ksh)\b/.test(readFileSync(file, "utf8"))
  );
}

/** The Renovate version renovate.yml runs (its action's `renovate-version` input). */
export function renovateVersion(root = ROOT): string {
  const workflow = readFileSync(join(root, ".github/workflows/renovate.yml"), "utf8");
  return String(/^\s+renovate-version: (\S+)$/m.exec(workflow)?.[1]);
}

export const LINTERS: Record<
  "actionlint" | "zizmor" | "shellcheck" | "hadolint" | "tflint" | "renovate",
  Linter
> = {
  actionlint: {
    image: "rhysd/actionlint",
    // renovate: datasource=docker depName=rhysd/actionlint
    version: "1.7.12",
    releases: "https://github.com/rhysd/actionlint/releases",
    reads: (path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path),
    args: (files) => files,
  },
  zizmor: {
    image: "ghcr.io/zizmorcore/zizmor",
    // renovate: datasource=docker depName=ghcr.io/zizmorcore/zizmor
    version: "1.30.1",
    releases: "https://github.com/zizmorcore/zizmor/releases",
    reads: (path) => /^\.github\/.+\.ya?ml$/.test(path),
    // Offline: the same audits with or without a GitHub token in the environment.
    args: () => ["--offline", "--config=.github/zizmor.yml", ".github"],
  },
  shellcheck: {
    image: "koalaman/shellcheck",
    // renovate: datasource=docker depName=koalaman/shellcheck
    version: "v0.11.0",
    releases: "https://github.com/koalaman/shellcheck/releases",
    reads: isShellScript,
    args: (files) => files,
  },
  hadolint: {
    image: "hadolint/hadolint",
    // renovate: datasource=docker depName=hadolint/hadolint
    version: "v2.15.1",
    releases: "https://github.com/hadolint/hadolint/releases",
    reads: (path) => /(^|\/)[^/]*Dockerfile$/.test(path),
    args: (files) => files,
  },
  tflint: {
    image: "ghcr.io/terraform-linters/tflint",
    // renovate: datasource=docker depName=ghcr.io/terraform-linters/tflint
    version: "v0.64.0",
    releases: "https://github.com/terraform-linters/tflint/releases",
    reads: (path) => /^infra\/tofu\/.+\.(tf|hcl)$/.test(path),
    // Every module and environment; the configuration by its full path, which tflint
    // otherwise looks for in each module's own folder.
    args: (_, root) => [
      "--chdir=infra/tofu",
      "--recursive",
      `--config=${root}/infra/tofu/.tflint.hcl`,
      "--format=compact",
    ],
  },
  renovate: {
    binary: "renovate-config-validator",
    image: "renovate/renovate",
    version: renovateVersion(),
    releases: "https://github.com/renovatebot/renovate/releases",
    reads: (path) => path === "renovate.json5" || OTHER_RENOVATE_CONFIGS.includes(path),
    // A stray copy, tracked or not, would quietly replace the real config.
    refuses: (files) => {
      const others = files.filter((path) => path !== "renovate.json5");
      return others.length > 0
        ? `Renovate's config lives in renovate.json5 alone, and it would read ${others.join(", ")} first: delete it`
        : undefined;
    },
    // No file: it finds renovate.json5 and validates it as a repository's configuration
    // (a file named here is validated as Renovate's own, global one).
    args: () => ["--strict"],
  },
};

/** Every file under `root` git tracks or would (new ones too), that still exists. */
export function repositoryFiles(run: Run = runSync, root = ROOT): string[] {
  return run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
  })
    .stdout.split("\0")
    .filter((path) => path && existsSync(join(root, path)));
}

/** The command that runs `name` at its version: a local binary of it, else Docker. */
function command(name: string, linter: Linter, run: Run, root: string): string[] | undefined {
  const binary = linter.binary ?? name;
  const local = run(binary, ["--version"], { cwd: root });
  if (`${local.stdout}${local.stderr}`.split(/\s+/).includes(linter.version.replace(/^v/, ""))) {
    return [binary];
  }
  if (run("docker", ["info"], { cwd: root, stdio: "ignore" }).status === 0) {
    return [
      "docker",
      ...["run", "--rm", "--memory=512m", "-v", `${root}:${root}:ro`, "-w", root],
      ...["--entrypoint", binary, `${linter.image}:${linter.version}`],
    ];
  }
  return undefined;
}

/** Runs the linter `argv[0]` over the files at `root` it reads; the exit code. */
export function lint(argv = process.argv.slice(2), run = runSync, root = ROOT): number {
  const [name = ""] = argv;
  const linter: Linter | undefined = Object.entries(LINTERS).find(([key]) => key === name)?.[1];
  if (!linter) {
    fail(`Which linter? One of ${Object.keys(LINTERS).join(", ")}.`);
    return 1;
  }
  const files = repositoryFiles(run, root).filter((path) => linter.reads(path, root));
  if (files.length === 0) {
    ok(`${name}: nothing to check`);
    return 0;
  }
  const refusal = linter.refuses?.(files);
  if (refusal) {
    fail(refusal);
    return 1;
  }
  const [program = "", ...rest] = command(name, linter, run, root) ?? [];
  if (!program) {
    fail(
      `${name} ${linter.version} isn't installed and Docker isn't running: install that version (${linter.releases}) or start Docker`,
    );
    return 1;
  }
  return (
    run(program, [...rest, ...linter.args(files, root)], { cwd: root, stdio: "inherit" }).status ??
    1
  );
}

await runMain(import.meta, lint);
