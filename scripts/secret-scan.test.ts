import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ROOT } from "./lib";
import { secretScan } from "./secret-scan";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const gitleaks = "git --pre-commit --staged --redact --verbose --no-banner --log-level=error";

describe("the secret scan", () => {
  it("uses a local gitleaks, and fails as it does", () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const { run, calls } = fakeRun((line) =>
      line.startsWith(`gitleaks ${gitleaks}`) ? { status: 1, stderr: "leak found" } : {},
    );
    expect(secretScan(run)).toBe(1);
    expect(calls).toEqual(["gitleaks version", `gitleaks ${gitleaks} .`]);
    expect(stderr).toHaveBeenCalledWith("leak found");
  });

  it("falls back to the container, mounting a worktree's main git directory too", () => {
    spyOn(process.stderr, "write").mockImplementation(() => true);
    const { run, calls } = fakeRun((line) => {
      if (line === "gitleaks version") {
        return { status: null };
      }
      if (line.startsWith("git rev-parse")) {
        return { stdout: "/elsewhere/repo/.git\n" };
      }
      return {};
    });
    expect(secretScan(run)).toBe(0);
    expect(calls.at(-1)).toBe(
      `docker run --rm --memory=256m -v ${ROOT}:${ROOT} -v /elsewhere/repo/.git:/elsewhere/repo/.git -w ${ROOT} ghcr.io/gitleaks/gitleaks:v8.28.0 ${gitleaks} ${ROOT}`,
    );
  });

  it("mounts only the checkout when its git directory is inside it", () => {
    spyOn(process.stderr, "write").mockImplementation(() => true);
    const { run, calls } = fakeRun((line) => {
      if (line === "gitleaks version") {
        return { status: 1 };
      }
      if (line.startsWith("git rev-parse")) {
        return { stdout: `${ROOT}/.git\n` };
      }
      if (line.startsWith("docker run")) {
        return { status: null };
      }
      return {};
    });
    expect(secretScan(run)).toBe(1);
    expect(calls.at(-1)).toStartWith(`docker run --rm --memory=256m -v ${ROOT}:${ROOT} -w`);
  });

  it("stops the commit when there's neither gitleaks nor Docker", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun(() => ({ status: 1 }));
    expect(secretScan(run)).toBe(1);
    expect(calls).toEqual(["gitleaks version", "docker info"]);
    expect(printed()).toContain("gitleaks isn't installed and Docker isn't running");
  });

  it("counts a scan that couldn't read git as a failure, though gitleaks passed", () => {
    const printed = captureOutput();
    spyOn(process.stderr, "write").mockImplementation(() => true);
    const { run } = fakeRun((line) =>
      line.startsWith("gitleaks git") ? { stderr: "[git] fatal: not a git repository" } : {},
    );
    expect(secretScan(run)).toBe(1);
    expect(printed()).toContain("nothing was scanned");
  });

  it("scans the commits of a range instead of the staged changes (the pre-push hook)", () => {
    spyOn(process.stderr, "write").mockImplementation(() => true);
    const { run, calls } = fakeRun();
    expect(secretScan(run, ["--range=abc..HEAD"])).toBe(0);
    expect(calls.at(-1)).toBe(
      "gitleaks git --log-opts abc..HEAD --redact --verbose --no-banner --log-level=error .",
    );
  });
});
