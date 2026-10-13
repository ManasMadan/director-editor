import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib";
import { LOCKFILES, OSV_VERSION, osv, osvReads } from "./osv";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const scan = "scan source --config=osv-scanner.toml --lockfile=bun.lock --lockfile=apps/ai/uv.lock";

describe("the known-vulnerability scan", () => {
  it("uses a local osv-scanner of CI's version, and fails as it does", () => {
    const { run, calls } = fakeRun((line) => {
      if (line === "osv-scanner --version") {
        return { stdout: `osv-scanner version: ${OSV_VERSION.slice(1)}\ncommit: x\n` };
      }
      return line.startsWith("osv-scanner scan") ? { status: 1 } : {};
    });
    expect(osv(run, "/repo")).toBe(1);
    expect(calls).toEqual(["osv-scanner --version", `osv-scanner ${scan}`]);
  });

  it("runs its image when the local osv-scanner is another version, or missing", () => {
    for (const local of [{ stdout: "osv-scanner version: 1.0.0\n" }, { status: null }]) {
      const { run, calls } = fakeRun((line) => (line === "osv-scanner --version" ? local : {}));
      expect(osv(run, "/repo")).toBe(0);
      expect(calls.at(-1)).toBe(
        `docker run --rm --memory=512m -v /repo:/repo:ro -w /repo ghcr.io/google/osv-scanner:${OSV_VERSION} ${scan}`,
      );
    }
  });

  it("fails rather than skipping when there's neither, and when the scanner can't start", () => {
    const printed = captureOutput();
    expect(osv(fakeRun(() => ({ status: 1 })).run)).toBe(1);
    expect(printed()).toContain("isn't installed and Docker isn't running");
    const { run } = fakeRun((line) => (line.startsWith("docker run") ? { status: null } : {}));
    expect(osv(run)).toBe(1);
  });

  it("reads the lockfiles and its exceptions, nothing else", () => {
    expect(["bun.lock", "apps/ai/uv.lock", "osv-scanner.toml"].every(osvReads)).toBe(true);
    expect(osvReads("package.json")).toBe(false);
  });

  it("is CI's scan: the same OSV-Scanner, lockfiles and exceptions", () => {
    const security = readFileSync(join(ROOT, ".github/workflows/security.yml"), "utf8");
    const job = security.slice(security.indexOf("  osv:"), security.indexOf("  misconfig:"));
    expect(job).toContain(`osv-scanner-action@`);
    expect(job).toMatch(new RegExp(`osv-scanner-action@[0-9a-f]{40} # ${OSV_VERSION}\\n`));
    expect([...job.matchAll(/--lockfile=(\S+)/g)].map((m) => m[1])).toEqual(LOCKFILES);
    expect(job).toContain("--config=osv-scanner.toml");
  });
});
