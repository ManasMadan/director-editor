/**
 * Fails when tracked source carries a `ponytail:` comment. That's a personal coding
 * tool's marker for a deliberate shortcut, and it tells the next reader nothing: write
 * why the code is the way it is, and where it stops being enough, in plain words.
 * `bun run lint` runs it (`bun run lint:markers` on its own).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT, runMain } from "./lib";
import { CODE } from "./suppressions";

const MARKER = /\bponytail:/;

/** This check and its test name the marker as data. */
const DEFINES_IT = new Set(["scripts/check-markers.ts", "scripts/check-markers.test.ts"]);

/** `path:line: text` for every line of a source file that has the marker. */
export function findMarkers(path: string, text: string): string[] {
  if (!CODE.test(path) || DEFINES_IT.has(path)) {
    return [];
  }
  return text
    .split("\n")
    .flatMap((line, index) => (MARKER.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : []));
}

/** Reports every marker in the files git tracks under `root`; the exit code. */
export function checkMarkers(root = ROOT): number {
  // Only files git tracks, and only those that mention it at all (git grep is fast).
  const candidates = spawnSync("git", ["grep", "-l", "-I", "-z", "-e", "ponytail:"], {
    cwd: root,
    encoding: "utf8",
  })
    .stdout.split("\0")
    .filter(Boolean);
  const found = candidates.flatMap((path) =>
    findMarkers(path, readFileSync(join(root, path), "utf8")),
  );
  if (found.length === 0) {
    ok("no ponytail: markers in tracked source");
    return 0;
  }
  for (const line of found) {
    fail(line);
  }
  console.log("\nRewrite each as a plain comment that says why (and the limit, if there is one).");
  return 1;
}

await runMain(import.meta, checkMarkers);
