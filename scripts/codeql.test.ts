import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEQL_VERSION,
  ciScan,
  cli,
  codeql,
  type Deps,
  findings,
  main,
  sha256,
  sourceTree,
} from "./codeql";
import { ROOT, runSync } from "./lib";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const temp = () => mkdtempSync(join(tmpdir(), "codeql-test-"));
const VERSION = CODEQL_VERSION.slice(1);

/** A SARIF report with one finding per [rule, level?] and these rules' properties. */
function sarif(results: { ruleId: string; level?: string }[]) {
  return {
    runs: [
      {
        tool: {
          driver: { rules: [{ id: "js/high", properties: { "security-severity": "7.5" } }] },
          extensions: [
            { rules: [{ id: "js/medium", properties: { "security-severity": "5.0" } }] },
            { rules: [{ id: "js/error", defaultConfiguration: { level: "error" } }] },
            {},
          ],
        },
        results: results.map((result) => ({
          ...result,
          message: { text: `${result.ruleId} found\nmore detail` },
          locations: [
            { physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 3 } } },
          ],
        })),
      },
    ],
  };
}

describe("what CI scans", () => {
  it("reads the languages and the query suite from security.yml", () => {
    expect(ciScan()).toEqual({
      languages: ["javascript-typescript", "python", "actions"],
      queries: "security-extended",
    });
  });

  it("uses CodeQL's default suite when the workflow names none", () => {
    const root = temp();
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github/workflows/security.yml"),
      "jobs:\n  codeql:\n    strategy: { matrix: { language: [python] } }\n    steps: [{ uses: x }]\n",
    );
    expect(ciScan(root)).toEqual({ languages: ["python"], queries: "default" });
  });
});

describe("a SARIF report's findings", () => {
  it("blocks on high security severity or error level, as the ruleset does", () => {
    const found = findings(
      sarif([
        { ruleId: "js/high" },
        { ruleId: "js/medium" },
        { ruleId: "js/error" },
        { ruleId: "js/medium", level: "error" },
        { ruleId: "js/unknown", level: "note" },
      ]),
    );
    expect(found.map((finding) => finding.blocks)).toEqual([true, false, true, true, false]);
    expect(found[0]?.text).toBe("a.ts:3 js/high js/high found");
  });

  it("names a finding without a location as such", () => {
    const report = {
      runs: [{ tool: { driver: {} }, results: [{ ruleId: "x", message: { text: "m" } }] }],
    };
    expect(findings(report)[0]?.text).toBe("undefined:undefined x m");
  });
});

describe("the CodeQL CLI", () => {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");

  it("hashes a file", async () => {
    const file = join(temp(), "f");
    writeFileSync(file, "bundle");
    expect(await sha256(file)).toBe(hash("bundle"));
  });

  /** Everything `cli` needs, with a run that answers `answer` and a fresh cache. */
  function deps(answer: (line: string) => object | undefined, extra: Partial<Deps> = {}) {
    const cache = temp();
    const { run, calls } = fakeRun((line) => answer(line) ?? { status: 1 });
    return {
      calls,
      cache,
      all: { run, root: ROOT, cache, platform: "linux" as const, bundles: {}, ...extra },
    };
  }

  it("uses a codeql on the PATH when it's this version", async () => {
    const { all } = deps((line) =>
      line === "codeql version --format=terse" ? { stdout: `${VERSION}\n` } : undefined,
    );
    expect(await cli(all)).toBe("codeql");
  });

  it("uses the bundle it fetched before", async () => {
    const { all, cache } = deps((line) =>
      line.includes(`/${CODEQL_VERSION}/codeql/codeql version`) ? {} : undefined,
    );
    expect(await cli(all)).toBe(join(cache, CODEQL_VERSION, "codeql", "codeql"));
  });

  it("has no bundle for a platform CodeQL doesn't publish one for", async () => {
    const printed = captureOutput();
    expect(await cli(deps(() => undefined, { platform: "win32" }).all)).toBeUndefined();
    expect(printed()).toContain("No CodeQL bundle for win32");
  });

  /** A bundle download where curl writes `body`, and tar unpacks when `unpacks`. */
  function download(body: string, unpacks: boolean, sha = hash(body)) {
    return deps(
      (line) => {
        const words = line.split(" ");
        if (words[0] === "curl") {
          writeFileSync(words[words.indexOf("-o") + 1] ?? "", body);
          return {};
        }
        if (words[0] === "tar" && unpacks) {
          mkdirSync(join(words[words.indexOf("-C") + 1] ?? "", "codeql"));
          return {};
        }
        return undefined;
      },
      { bundles: { linux: { name: "b.tar.gz", sha256: sha } } },
    );
  }

  it("downloads the bundle once, checks its SHA-256 and unpacks it", async () => {
    captureOutput();
    const { all, cache, calls } = download("bundle", true);
    expect(await cli(all)).toBe(join(cache, CODEQL_VERSION, "codeql", "codeql"));
    expect(existsSync(join(cache, CODEQL_VERSION, "codeql"))).toBe(true);
    expect(calls[2]).toContain(
      `https://github.com/github/codeql-action/releases/download/codeql-bundle-${CODEQL_VERSION}/b.tar.gz`,
    );
    // Nothing left of the download.
    expect(readdirSync(cache)).toEqual([CODEQL_VERSION]);
  });

  it("refuses a bundle that doesn't match its checksum, or doesn't unpack", async () => {
    const printed = captureOutput();
    const wrong = download("tampered", true, hash("bundle"));
    expect(await cli(wrong.all)).toBeUndefined();
    expect(printed()).toContain("doesn't match its SHA-256");
    expect(readdirSync(wrong.cache)).toEqual([]);
    expect(await cli(download("bundle", false).all)).toBeUndefined();
    expect(printed()).toContain("Couldn't unpack");
  });

  it("says when the download fails", async () => {
    const printed = captureOutput();
    const { all } = deps(() => undefined, { bundles: { linux: { name: "b", sha256: "x" } } });
    expect(await cli(all)).toBeUndefined();
    expect(printed()).toContain("Couldn't download");
  });
});

describe("the code it scans", () => {
  it("is what git tracks or would, as it is on disk", () => {
    const root = temp();
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    mkdirSync(join(root, "src"));
    for (const file of ["src/tracked.ts", "gone.ts", "ignored.txt"]) {
      writeFileSync(join(root, file), file);
    }
    runSync("git", ["init", "-q"], { cwd: root });
    runSync("git", ["add", ".gitignore", "src/tracked.ts", "gone.ts"], { cwd: root });
    writeFileSync(join(root, "untracked.ts"), "new");
    writeFileSync(join(root, "src/tracked.ts"), "edited");
    runSync("rm", [join(root, "gone.ts")]);
    const to = join(temp(), "source");
    sourceTree(runSync, root, to);
    expect(readdirSync(to).sort()).toEqual([".gitignore", "src", "untracked.ts"]);
    expect(readFileSync(join(to, "src/tracked.ts"), "utf8")).toBe("edited");
  });

  it("stops on anything but a file that's gone", () => {
    const root = temp();
    writeFileSync(join(root, "a"), "a file");
    const { run } = fakeRun(() => ({ stdout: "a\0a/b\0" }));
    expect(() => sourceTree(run, root, join(temp(), "source"))).toThrow();
  });
});

describe("a scan", () => {
  /** A run where codeql is on the PATH and analyze writes `report` as its SARIF output. */
  function scanning(report: object, fails = "") {
    return fakeRun((line) => {
      if (line === "codeql version --format=terse") {
        return { stdout: VERSION };
      }
      if (fails && line.includes(fails)) {
        return { status: 2, stdout: "out\n", stderr: "what went wrong\n" };
      }
      const output = /--output=(\S+)/.exec(line)?.[1];
      if (output) {
        writeFileSync(output, JSON.stringify(report));
      }
      return {};
    });
  }

  it("creates a database per language and runs CI's suite on it", async () => {
    const printed = captureOutput();
    const { run, calls } = scanning(sarif([{ ruleId: "js/medium" }]));
    expect(await codeql(["javascript-typescript", "python"], { run })).toBe(0);
    const analyzed = calls.filter((line) => line.startsWith("codeql database"));
    expect(analyzed[0]).toMatch(
      /database create \S+db-javascript-typescript --language=javascript-typescript --build-mode=none --source-root=\S+ --threads=0 --ram=\d+$/,
    );
    expect(analyzed[1]).toContain(
      "codeql/javascript-queries:codeql-suites/javascript-security-extended.qls --format=sarif-latest",
    );
    expect(analyzed[3]).toContain(
      "codeql/python-queries:codeql-suites/python-security-extended.qls",
    );
    expect(printed()).toContain(
      "javascript-typescript: 0 blocking, and 1 below the ruleset's threshold",
    );
  });

  it("fails on a blocking finding, printing where it is", async () => {
    const printed = captureOutput();
    const { run } = scanning(sarif([{ ruleId: "js/high" }]));
    expect(await codeql(["actions"], { run })).toBe(1);
    expect(printed()).toContain("a.ts:3 js/high js/high found");
    expect(printed()).toContain("actions: 1 blocking");
  });

  it("scans every language CI does when given none", async () => {
    captureOutput();
    const { run, calls } = scanning(sarif([]));
    expect(await main([], { run })).toBe(0);
    expect(calls.filter((line) => line.includes("database create"))).toHaveLength(3);
  });

  it("refuses a language CI doesn't scan", async () => {
    const printed = captureOutput();
    expect(await main(["--languages", "go,python"], { run: scanning(sarif([])).run })).toBe(1);
    expect(printed()).toContain("Not a language CI scans: go");
  });

  it("fails when CodeQL does, with its output", async () => {
    captureOutput();
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await codeql(["python"], { run: scanning(sarif([]), "database create").run })).toBe(1);
    expect(stderr).toHaveBeenCalledWith("out\nwhat went wrong\n");
  });

  it("fails when there's no CLI to run", async () => {
    captureOutput();
    const { run } = fakeRun(() => ({ status: 1 }));
    expect(await codeql(["python"], { run, platform: "aix", cache: temp() })).toBe(1);
  });
});
