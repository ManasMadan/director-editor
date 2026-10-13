import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "./lib";
import { composeProject, main, setup, syncEnv } from "./setup";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

function files(env?: string) {
  const dir = mkdtempSync(join(tmpdir(), "setup-"));
  const paths = { envPath: join(dir, ".env"), examplePath: join(dir, ".env.example") };
  writeFileSync(paths.examplePath, "PORT=3001\nAUTH_SECRET=change-me\nNEW=x\n");
  if (env !== undefined) {
    writeFileSync(paths.envPath, env);
  }
  return paths;
}

describe("setup", () => {
  it("creates .env with fresh secrets, then installs, starts, migrates and generates", () => {
    const printed = captureOutput();
    const paths = files();
    const { run, calls } = fakeRun();
    expect(setup({ run, ...paths })).toBe(0);
    const env = parseEnv(readFileSync(paths.envPath, "utf8"));
    expect(env.get("PORT")).toBe("3001");
    expect(env.get("AUTH_SECRET")).toMatch(/^[\w-]{43}$/);
    expect(printed()).toContain("Created .env from .env.example");
    expect(printed()).toContain("Generated AUTH_SECRET");
    expect(calls).toEqual([
      "bun install",
      "bun scripts/services.ts up",
      "bun run db:deploy",
      "bun run gen",
    ]);
    expect(printed()).toContain("Setup complete.");
  });

  it("fails on an unreadable .env.example rather than leaving no .env", () => {
    const paths = files();
    expect(() => syncEnv(paths.envPath, `${paths.examplePath}.missing`)).toThrow(/ENOENT/);
  });

  it("keeps existing values and adds only what's missing", () => {
    captureOutput();
    const paths = files("PORT=4000\nAUTH_SECRET=mine\n");
    expect(setup({ run: fakeRun().run, ...paths })).toBe(0);
    expect(readFileSync(paths.envPath, "utf8")).toBe("PORT=4000\nAUTH_SECRET=mine\nNEW=x\n");
  });

  it("stops at the first step that fails, with its exit code", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun((line) =>
      line === "bun scripts/services.ts up" ? { status: 3 } : {},
    );
    expect(setup({ run, ...files("") })).toBe(3);
    expect(calls).toHaveLength(2);
    expect(printed()).not.toContain("Setup complete.");
    expect(setup({ run: fakeRun(() => ({ status: null })).run, ...files("") })).toBe(1);
  });

  it("syncs .env on its own, as bun dev does before starting", () => {
    captureOutput();
    const paths = files("PORT=4000\nAUTH_SECRET=change-me\n");
    const { run, calls } = fakeRun();
    expect(main(["--env"], { run, ...paths })).toBe(0);
    expect(calls).toEqual([]);
    const env = parseEnv(readFileSync(paths.envPath, "utf8"));
    expect(env.get("PORT")).toBe("4000");
    expect(env.get("NEW")).toBe("x");
    expect(env.get("AUTH_SECRET")).not.toBe("change-me");
  });

  it("runs the whole setup without --env, and syncs directly when asked", () => {
    captureOutput();
    const { run, calls } = fakeRun();
    expect(main([], { run, ...files() })).toBe(0);
    expect(calls).toHaveLength(4);
    const paths = files("");
    syncEnv(paths.envPath, paths.examplePath);
    expect(parseEnv(readFileSync(paths.envPath, "utf8")).get("NEW")).toBe("x");
  });

  describe("with its own stack of services", () => {
    const stackFiles = () => {
      const paths = files("");
      writeFileSync(
        paths.examplePath,
        "POSTGRES_PORT=55432\nDATABASE_URL=postgresql://localhost:55432/app\nWEB_PORT=3000\nWEB_URL=http://localhost:3000\nAUTH_SECRET=change-me\n",
      );
      return { ...paths, forTests: join(dirname(paths.envPath), ".env.stack") };
    };

    it("moves this checkout's ports, URLs and compose project, and tells the tests", () => {
      const printed = captureOutput();
      const { forTests, ...paths } = stackFiles();
      const { run, calls } = fakeRun();
      expect(setup({ run, ...paths, stack: 1, project: "app" })).toBe(0);
      const env = parseEnv(readFileSync(paths.envPath, "utf8"));
      expect(env.get("POSTGRES_PORT")).toBe("55532");
      expect(env.get("DATABASE_URL")).toBe("postgresql://localhost:55532/app");
      // The apps' ports too, and the URLs that name them.
      expect(env.get("WEB_PORT")).toBe("3100");
      expect(env.get("WEB_URL")).toBe("http://localhost:3100");
      expect(env.get("COMPOSE_PROJECT_NAME")).toBe("app-stack1");
      expect(env.get("AUTH_SECRET")).not.toBe("change-me");
      // The tests get the ports and URLs, and no secret.
      expect(readFileSync(forTests, "utf8")).toBe(
        "POSTGRES_PORT=55532\nWEB_PORT=3100\nDATABASE_URL=postgresql://localhost:55532/app\nWEB_URL=http://localhost:3100\n",
      );
      expect(printed()).toContain("Stack 1: compose project app-stack1, Postgres on 55532");
      expect(printed()).toContain("the site on http://localhost:3100");
      expect(calls).toContain("bun scripts/services.ts up");
    });

    it("goes back to the defaults with stack 0, with --env too", () => {
      captureOutput();
      const { forTests, ...paths } = stackFiles();
      expect(main(["--env", "--stack", "2"], { ...paths, project: "app" })).toBe(0);
      expect(existsSync(forTests)).toBe(true);
      expect(main(["--env", "--stack", "0"], { ...paths, project: "app" })).toBe(0);
      const env = parseEnv(readFileSync(paths.envPath, "utf8"));
      expect(env.get("POSTGRES_PORT")).toBe("55432");
      expect(env.get("COMPOSE_PROJECT_NAME")).toBe("app");
      expect(existsSync(forTests)).toBe(false);
      // The project named in this repository's docker-compose.yml.
      expect(main(["--env", "--stack", "0"], paths)).toBe(0);
      expect(parseEnv(readFileSync(paths.envPath, "utf8")).get("COMPOSE_PROJECT_NAME")).toBe(
        composeProject(),
      );
    });

    it("refuses a stack that isn't 0 to 9, before touching anything", () => {
      const printed = captureOutput();
      const { run, calls } = fakeRun();
      for (const argv of [["--stack"], ["--stack", "10"], ["--env", "--stack", "x"]]) {
        expect(main(argv, { run, ...stackFiles() })).toBe(1);
      }
      expect(calls).toEqual([]);
      expect(printed()).toContain("--stack takes a number from 0 to 9");
    });
  });
});
