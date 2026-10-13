/**
 * Known vulnerabilities in what the lockfiles pin: `bun scripts/osv.ts`, the Security
 * workflow's OSV job run locally, which the pre-commit hook runs when a lockfile is
 * staged. OSV-Scanner with osv-scanner.toml (the reviewed exceptions), at CI's version:
 * a local osv-scanner of that version, else its image in Docker; with neither, it fails
 * and says how to get one, rather than skipping the scan.
 */
import { fail, ROOT, runMain, runSync } from "./lib";

// renovate: datasource=docker depName=ghcr.io/google/osv-scanner
export const OSV_VERSION = "v2.6.0";

/** The lockfiles CI scans (security.yml's OSV job), from the repository root. */
export const LOCKFILES = ["bun.lock", "apps/ai/uv.lock"];

/** Whether the scan reads `path` (a path from the repository root). */
export const osvReads = (path: string) => LOCKFILES.includes(path) || path === "osv-scanner.toml";

/** Scans the lockfiles at `root`; the exit code (1 on a vulnerability). */
export function osv(run = runSync, root = ROOT): number {
  const scan = [
    "scan",
    "source",
    "--config=osv-scanner.toml",
    ...LOCKFILES.map((file) => `--lockfile=${file}`),
  ];
  let command: [string, string[]];
  const version = `osv-scanner version: ${OSV_VERSION.slice(1)}\n`;
  if (run("osv-scanner", ["--version"], { cwd: root }).stdout.includes(version)) {
    command = ["osv-scanner", scan];
  } else if (run("docker", ["info"], { cwd: root, stdio: "ignore" }).status === 0) {
    command = [
      "docker",
      [
        "run",
        "--rm",
        "--memory=512m",
        "-v",
        `${root}:${root}:ro`,
        "-w",
        root,
        `ghcr.io/google/osv-scanner:${OSV_VERSION}`,
        ...scan,
      ],
    ];
  } else {
    fail(
      `osv-scanner ${OSV_VERSION} isn't installed and Docker isn't running: install that version (https://github.com/google/osv-scanner/releases) or start Docker`,
    );
    return 1;
  }
  return run(command[0], command[1], { cwd: root, stdio: "inherit" }).status ?? 1;
}

await runMain(import.meta, osv);
