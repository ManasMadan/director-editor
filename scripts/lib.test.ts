import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envLine,
  fail,
  listening,
  messageOf,
  ok,
  parseEnv,
  readEnv,
  removeEnvValue,
  runMain,
  runSync,
  warn,
  writeEnvValue,
} from "./lib";
import { captureOutput } from "./stand-ins";

const dir = () => mkdtempSync(join(tmpdir(), "env-"));

/** What a runtime's own --env-file reads for KEY from a file holding `line`. */
function readBack(runtime: "node" | "bun", line: string) {
  const file = join(dir(), ".env");
  writeFileSync(file, `${line}\n`);
  const run = Bun.spawnSync(
    [runtime, `--env-file=${file}`, "-e", "process.stdout.write(process.env.KEY ?? '<unset>')"],
    {
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  return run.stdout.toString();
}

describe(".env values", () => {
  it.each([
    "plain-value_1.2:3/x",
    "sk_test_abc+/=",
    "has spaces and # a hash",
    'it"s "quoted"',
    "back\\slash",
    "two\nlines",
    "it's",
    "",
  ])("%j reads back unchanged in Node and in Bun", (value) => {
    const line = envLine("KEY", value);
    expect(readBack("node", line)).toBe(value);
    expect(readBack("bun", line)).toBe(value);
    expect(parseEnv(line).get("KEY")).toBe(value);
  });

  it("refuses what no spelling carries through both", () => {
    expect(() => envLine("KEY", "a$$b")).toThrow(/Bun expands/);
    expect(() => envLine("KEY", `it's "both"\nlines`)).toThrow(/both quotes/);
  });

  it("replaces a line in place, leaving the rest alone, and removes one", () => {
    const file = join(dir(), ".env");
    writeFileSync(file, "# comment\nA=1\nexport B=2\nAB=3\n");
    writeEnvValue(file, "A", "new value");
    writeEnvValue(file, "B", "x");
    writeEnvValue(file, "C", "added");
    expect(readFileSync(file, "utf8")).toBe("# comment\nA='new value'\nB=x\nAB=3\nC=added\n");
    expect(removeEnvValue(file, "AB")).toBe(true);
    expect(removeEnvValue(file, "AB")).toBe(false);
    expect(parseEnv(readFileSync(file, "utf8"))).toEqual(
      new Map([
        ["A", "new value"],
        ["B", "x"],
        ["C", "added"],
      ]),
    );
    expect(removeEnvValue(join(dir(), "missing"), "A")).toBe(false);
  });

  it("creates a missing file readable by its owner alone, and reads none as empty", () => {
    const file = join(dir(), ".env");
    expect(readEnv(file)).toEqual(new Map());
    writeEnvValue(file, "A", "1");
    expect(readFileSync(file, "utf8")).toBe("\nA=1\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readEnv(file)).toEqual(new Map([["A", "1"]]));
  });

  it("passes on what isn't a missing file", () => {
    const folder = dir();
    expect(() => readEnv(folder)).toThrow(/EISDIR/);
    expect(() => removeEnvValue(folder, "A")).toThrow(/EISDIR/);
  });
});

describe("running a command", () => {
  it("returns its status and output as text", () => {
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";
    expect(runSync("bun", ["-e", script])).toEqual({ status: 3, stdout: "out", stderr: "err" });
  });

  it("has no status for a command that doesn't exist", () => {
    expect(runSync("no-such-command-anywhere", []).status).toBeNull();
  });

  it("keeps output larger than spawnSync's default limit", () => {
    const script = "process.stdout.write('x'.repeat(3 * 1024 * 1024))";
    expect(runSync("bun", ["-e", script]).stdout).toHaveLength(3 * 1024 * 1024);
  });
});

describe("whether a port listens", () => {
  it("sees a port that accepts connections, and not one that refuses them", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    expect(await listening(port)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    const started = Date.now();
    expect(await listening(port, 500)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("what an error says", () => {
  it("is an Error's message, or the thrown value itself", () => {
    expect(messageOf(new Error("broken"))).toBe("broken");
    expect(messageOf("plain")).toBe("plain");
  });
});

describe("the status lines", () => {
  it("mark each line as passed, a warning or failed", () => {
    const printed = captureOutput();
    ok("fine");
    warn("careful");
    fail("broken");
    expect(printed()).toBe(
      ["  \x1b[32m✔\x1b[0m fine", "  \x1b[33m!\x1b[0m careful", "  \x1b[31m✖\x1b[0m broken"].join(
        "\n",
      ),
    );
    mock.restore();
  });
});

describe("a script's entry point", () => {
  it("runs only when the file is run, and exits with the code it returns", async () => {
    const codes: number[] = [];
    const exit = (code: number) => codes.push(code);
    await runMain({ main: false }, () => 3, exit);
    expect(codes).toEqual([]);
    await runMain({ main: true }, () => 3, exit);
    await runMain({ main: true }, async () => 4, exit);
    // One that reports nothing succeeded.
    await runMain({ main: true }, () => undefined, exit);
    expect(codes).toEqual([3, 4, 0]);
  });
});
