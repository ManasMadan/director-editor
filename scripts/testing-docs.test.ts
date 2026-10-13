/**
 * docs/testing.md's "Skipped tests" table against the tests and CI it describes: each row
 * names the variables its test is skipped without, the test reads exactly those, and a
 * row whose variables CI sets says which CI job runs it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The table's rows: the test file, when it's skipped, and where it runs. */
function skipped(doc = readFileSync(join(ROOT, "docs/testing.md"), "utf8")) {
  const section = doc.split("## Skipped tests")[1]?.split("\n## ")[0] ?? "";
  return section
    .split("\n")
    .filter((line) => /^\| `[^`]+\.(ts|tsx|py)` \|/.test(line))
    .map((line) => {
      const [file = "", when = "", where = ""] = line.slice(2, -2).split(" | ");
      return { file: file.replaceAll("`", ""), when, where };
    });
}

/** The variables a cell names, in backticks. */
const variables = (cell: string) =>
  [...cell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].flatMap(([, v]) => (v ? [v] : []));

/** Every variable ci.yml sets, on a job or a step. */
function ciVariables() {
  type Env = { env?: Record<string, unknown> };
  const ci = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, Env & { steps?: Env[] }>;
  };
  return new Set(
    Object.values(ci.jobs).flatMap((job) => [
      ...Object.keys(job.env ?? {}),
      ...(job.steps ?? []).flatMap((step) => Object.keys(step.env ?? {})),
    ]),
  );
}

describe("docs/testing.md's skipped tests", () => {
  const rows = skipped();

  it("lists some", () => {
    expect(rows.length).toBeGreaterThan(3);
  });

  it("name the variables each test is skipped without, as the test reads or names them", () => {
    for (const { file, when } of rows) {
      const names = variables(when);
      expect({ file, names: names.length > 0 }).toEqual({ file, names: true });
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const name of names) {
        // Read from the environment, or named in the skip's message: not a local constant.
        const read = new RegExp(`process\\.env\\.${name}\\b|["'\`][^"'\`\\n]*\\b${name}\\b`);
        expect({ file, name, read: read.test(source) }).toEqual({ file, name, read: true });
      }
    }
  });

  it("say which CI job runs a test whose variables CI sets", () => {
    const ci = ciVariables();
    for (const { file, when, where } of rows) {
      if (variables(when).every((name) => ci.has(name))) {
        expect({ file, where }).toEqual({ file, where: expect.stringMatching(/CI's [\w-]+ job/) });
      }
    }
  });
});
