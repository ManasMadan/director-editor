/**
 * Secrets in the staged changes (the pre-commit hook), with gitleaks and the reviewed
 * findings in .gitleaksignore, so a key never reaches history; CI scans again. Uses a
 * local gitleaks, or its container when Docker is running; with neither, the commit
 * stops and says how to get one, rather than skipping the scan.
 *
 *   bun scripts/secret-scan.ts                    the staged changes
 *   bun scripts/secret-scan.ts --range=<a>..<b>   those commits (the pre-push hook)
 */
import { fail, ROOT, runMain, runSync } from "./lib";

// renovate: datasource=github-releases depName=gitleaks/gitleaks
const VERSION = "v8.28.0";
const ARGS = ["--redact", "--verbose", "--no-banner", "--log-level=error"];

/** Scans the staged changes, or a range of commits, with gitleaks; the exit code. */
export function secretScan(run = runSync, argv = process.argv.slice(2)): number {
  const range = argv.find((arg) => arg.startsWith("--range="))?.slice("--range=".length);
  const scope = range ? ["git", "--log-opts", range] : ["git", "--pre-commit", "--staged"];
  const has = (command: string, args: string[]) =>
    run(command, args, { cwd: ROOT, stdio: "ignore" }).status === 0;

  let command: [string, string[]];
  if (has("gitleaks", ["version"])) {
    command = ["gitleaks", [...scope, ...ARGS, "."]];
  } else if (has("docker", ["info"])) {
    // Mounted at their own paths: in a git worktree, .git is a file naming the main
    // repository's git directory by absolute path, which must resolve in the container too.
    const gitDir = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: ROOT,
    }).stdout.trim();
    const mounts = [ROOT, ...(gitDir.startsWith(`${ROOT}/`) ? [] : [gitDir])].flatMap((path) => [
      "-v",
      `${path}:${path}`,
    ]);
    command = [
      "docker",
      [
        "run",
        "--rm",
        "--memory=256m",
        ...mounts,
        "-w",
        ROOT,
        `ghcr.io/gitleaks/gitleaks:${VERSION}`,
        ...scope,
        ...ARGS,
        ROOT,
      ],
    ];
  } else {
    fail(
      "gitleaks isn't installed and Docker isn't running: install gitleaks (`brew install gitleaks`) or start Docker",
    );
    return 1;
  }
  const scan = run(command[0], command[1], { cwd: ROOT, stdio: ["inherit", "inherit", "pipe"] });
  process.stderr.write(scan.stderr);
  // gitleaks exits 0 when git itself fails (it then scanned nothing): that's no pass.
  if (scan.status === 0 && /\[git\] fatal/.test(scan.stderr)) {
    fail("gitleaks couldn't read the changes (git failed above), so nothing was scanned");
    return 1;
  }
  return scan.status ?? 1;
}

await runMain(import.meta, secretScan);
