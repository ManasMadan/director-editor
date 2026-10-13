import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { checkPatterns, findPatterns } from "./check-patterns";
import { captureOutput } from "./stand-ins";

afterEach(() => mock.restore());

const SOURCE = "apps/api/src/x.ts";
const TEST = "apps/api/test/x.test.ts";
const problems = (path: string, text: string) =>
  findPatterns(path, text).map(({ problem }) => problem.split(":")[0]);

describe("the code pattern check, in source", () => {
  it("refuses parsed JSON cast to a type", () => {
    expect(problems(SOURCE, "const a = JSON.parse(text) as { a: 1 };")).toEqual([
      "parsed JSON cast to a type",
    ]);
    expect(problems(SOURCE, "const a = (await response.json()) as A;")).toEqual([
      "parsed JSON cast to a type",
    ]);
    expect(problems(SOURCE, "const a = schema.parse(JSON.parse(text));")).toEqual([]);
    expect(problems(SOURCE, "const a = other.parse(text) as A;")).toEqual([]);
    expect(problems(SOURCE, "const a = response.json(1) as A;")).toEqual([]);
    expect(problems(SOURCE, "const a = value as A;")).toEqual([]);
  });

  it("refuses a type argument on raw SQL", () => {
    expect(problems(SOURCE, "await db.$queryRaw<Row[]>`SELECT 1`;")).toEqual([
      "raw SQL with a type argument",
    ]);
    expect(problems(SOURCE, 'await db.$queryRawUnsafe<Row[]>("SELECT 1");')).toEqual([
      "raw SQL with a type argument",
    ]);
    expect(problems(SOURCE, "await rows(row, db.$queryRaw`SELECT 1`);")).toEqual([]);
    expect(problems(SOURCE, "const a = make<A>`x`; call<B>();")).toEqual([]);
  });

  it("refuses an optional chain three deep, once per chain", () => {
    expect(problems(SOURCE, "const a = b?.c?.d?.e;")).toEqual(["an optional chain three deep"]);
    expect(problems(SOURCE, "const a = b?.c?.[d]?.()!.e;")).toEqual([
      "an optional chain three deep",
    ]);
    expect(problems(SOURCE, "const a = b?.c?.d.e;")).toEqual([]);
  });

  it('refuses a role compared with "member", either way round', () => {
    expect(problems(SOURCE, 'if (member.role === "member") deny();')).toEqual([
      'a role compared with "member"',
    ]);
    expect(problems(SOURCE, 'if ("member" !== role) allow();')).toEqual([
      'a role compared with "member"',
    ]);
    expect(problems(SOURCE, 'if (role === "owner" || kind === "member") allow();')).toEqual([]);
    expect(problems(SOURCE, 'if (role == "member" || "member" === kind) allow();')).toEqual([]);
  });

  it("refuses an error answered by hand, outside the shared helper", () => {
    const byHand = 'reply.status(404).send({ code: "NOT_FOUND" });';
    expect(problems(SOURCE, byHand)).toEqual(["an error sent by hand"]);
    expect(problems(SOURCE, 'reply.code(400).send({ code: "X" });')).toEqual([
      "an error sent by hand",
    ]);
    expect(problems("packages/nest-common/src/http-errors.ts", byHand)).toEqual([]);
    expect(problems(SOURCE, "reply.status(200).send({ received: true });")).toEqual([]);
    expect(problems(SOURCE, "reply.status(200).send(body); reply.send({ code });")).toEqual([]);
    expect(problems(SOURCE, "reply.header(200).send({ code }); send({ code });")).toEqual([]);
  });

  it("applies to the repo's scripts, load test and code generators too", () => {
    const cast = "const a = JSON.parse(text) as A;";
    for (const path of ["scripts/x.ts", "load/api.ts", "turbo/generators/config.ts"]) {
      expect(problems(path, cast)).toEqual(["parsed JSON cast to a type"]);
    }
  });

  it("leaves tests, generated code and everything else alone", () => {
    const cast = "const a = JSON.parse(text) as A;";
    expect(problems("apps/api/src/x.test.ts", cast)).toEqual([]);
    expect(problems("scripts/x.test.ts", cast)).toEqual([]);
    expect(problems("apps/api/src/generated/x.ts", cast)).toEqual([]);
    expect(problems("docs/x.md", cast)).toEqual([]);
  });
});

describe("the code pattern check, in tests", () => {
  it("refuses a fixed sleep", () => {
    const sleep = "await new Promise((resolve) => setTimeout(resolve, 50));";
    expect(problems(TEST, sleep)).toEqual(["a fixed sleep"]);
    expect(problems(TEST, "await new Promise(function (r) { setTimeout(r, 5); });")).toEqual([
      "a fixed sleep",
    ]);
    expect(problems(SOURCE, sleep)).toEqual([]);
  });

  it("allows a poll, and a timer that isn't a promise's", () => {
    expect(problems(TEST, "while (!done()) await new Promise((r) => setTimeout(r, 20));")).toEqual(
      [],
    );
    expect(problems(TEST, "setTimeout(resolve, 5); setTimeout(() => go(), 5);")).toEqual([]);
    expect(problems(TEST, "new Promise((resolve) => setTimeout(other, 5));")).toEqual([]);
    expect(problems(TEST, "new Thing((resolve) => setTimeout(resolve, 5));")).toEqual([]);
    expect(problems(TEST, "function f() { setTimeout(resolve, 5); }")).toEqual([]);
    expect(problems(TEST, "setTimeout(resolve, 5);")).toEqual([]);
  });
});

describe("the check over tracked files", () => {
  it("fails on a tracked file with a finding, with its line, and passes without", async () => {
    const root = mkdtempSync(join(tmpdir(), "patterns-"));
    await $`git init -q`.cwd(root);
    mkdirSync(join(root, "apps/api/src"), { recursive: true });
    writeFileSync(join(root, "apps/api/src/x.ts"), "const a = 1;\nconst b = c?.d?.e?.f;\n");
    writeFileSync(join(root, "apps/api/src/untracked.ts"), "const b = c?.d?.e?.f;\n");
    await $`git add apps/api/src/x.ts`.cwd(root);
    const printed = captureOutput();
    expect(checkPatterns(root)).toBe(1);
    expect(printed()).toContain("apps/api/src/x.ts:2: an optional chain three deep");
    expect(printed()).not.toContain("untracked.ts");

    writeFileSync(join(root, "apps/api/src/x.ts"), "const b = c?.d.e;\n");
    expect(checkPatterns(root)).toBe(0);
    expect(printed()).toContain("no ruled-out code patterns");
  });
});
