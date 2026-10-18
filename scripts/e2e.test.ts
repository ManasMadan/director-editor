import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2e, listeningAt, type Stack, stackPorts } from "./e2e";
import { ROOT } from "./lib";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

/** A stack that starts and answers at once; what it was asked to do is recorded. */
function stack(overrides: Partial<Stack> = {}) {
  const commands = fakeRun();
  const started: string[] = [];
  const killed: number[] = [];
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  const environments: Record<string, string | undefined>[] = [];
  const given: Partial<Stack> = {
    run: commands.run,
    start: (_, args, options) => {
      started.push(`${options.cwd} ${args.join(" ")}`);
      environments.push(options.env ?? {});
      return { pid: 1000 + started.length, exitCode: null };
    },
    kill: (pid) => {
      killed.push(pid);
    },
    isListening: async () => false,
    fetch: async () => ({ ok: true }),
    sleep: async () => undefined,
    onSignal: (signal, handler) => handlers.set(signal, handler),
    exit: (code) => exits.push(code),
    logs: mkdtempSync(join(tmpdir(), "e2e-logs-")),
    // Not the developer's .env, which Bun loads into process.env: .env.example's ports.
    env: {},
    ...overrides,
  };
  const ran = commands.options;
  return { given, calls: commands.calls, ran, started, environments, killed, handlers, exits };
}

describe("the e2e run", () => {
  it("builds, starts every service, runs web and the fuzzing, then stops them", async () => {
    const printed = captureOutput();
    const { given, calls, started, killed } = stack();
    expect(await e2e([], given)).toBe(0);
    expect(calls).toEqual([
      "bunx turbo run build --filter=@repo/api --filter=@repo/worker --filter=@repo/notifications --filter=@repo/webhooks --filter=@repo/web",
      "bunx playwright test",
      "bun run test:fuzz",
    ]);
    expect(started).toHaveLength(7);
    expect(started[0]).toBe(`${join(ROOT, "apps/api")} run start`);
    expect(killed).toEqual(started.map((_, index) => -(1001 + index)));
    expect(printed()).toContain("web ready");
  });

  it("runs one app's suite with the rest of the arguments for Playwright", async () => {
    captureOutput();
    const { given, calls } = stack();
    expect(await e2e(["--app", "web", "e2e/auth.spec.ts"], given)).toBe(0);
    expect(calls.slice(1)).toEqual(["bunx playwright test e2e/auth.spec.ts"]);
  });

  it("leaves the fuzzing to the second shard", async () => {
    captureOutput();
    const first = stack();
    await e2e(["--shard=1/4"], first.given);
    expect(first.calls.slice(1)).toEqual(["bunx playwright test --shard=1/4"]);
    const second = stack();
    await e2e(["--shard=2/4"], second.given);
    expect(second.calls.slice(1)).toEqual([
      "bunx playwright test --shard=2/4",
      "bun run test:fuzz",
    ]);
  });

  it("fuzzes from the root, with the stack's ports, as a test run", async () => {
    captureOutput();
    const { given, calls, ran } = stack();
    expect(await e2e(["--app", "fuzz"], given)).toBe(0);
    expect(calls.slice(1)).toEqual(["bun run test:fuzz"]);
    expect(ran[1]).toMatchObject({ cwd: ROOT, env: { NODE_ENV: "test", API_PORT: "3001" } });
  });

  it("waits for a service until it answers", async () => {
    captureOutput();
    const answers = [Promise.reject(new Error("refused")), Promise.resolve({ ok: false })];
    let sleeps = 0;
    const { given } = stack({
      fetch: () => answers.shift() ?? Promise.resolve({ ok: true }),
      sleep: async () => {
        sleeps += 1;
      },
    });
    expect(await e2e(["--app", "web"], given)).toBe(0);
    expect(sleeps).toBe(2);
  });

  it("fails with a suite's exit code", async () => {
    captureOutput();
    const failing = stack({
      run: fakeRun((line) => (line.includes("playwright") ? { status: 2 } : {})).run,
    });
    expect(await e2e(["--app", "web"], failing.given)).toBe(2);
    const crashed = stack({
      run: fakeRun((line) => (line.includes("test:fuzz") ? { status: null } : {})).run,
    });
    expect(await e2e(["--app", "fuzz"], crashed.given)).toBe(1);
  });

  it("shows the log of a service that exits or never becomes ready, and stops the rest", async () => {
    const printed = captureOutput();
    const exited = stack({
      start: () => ({ pid: 7, exitCode: 1 }),
    });
    expect(await e2e(["--app", "web"], exited.given)).toBe(1);
    expect(printed()).toContain("api never became ready (logs/api.log)");
    // Exited already: nothing to stop.
    expect(exited.killed).toEqual([]);

    const slow = stack({
      readyTimeoutMs: 0,
      kill: () => {
        throw new Error("ESRCH");
      },
    });
    expect(await e2e(["--app", "web"], slow.given)).toBe(1);
  });

  it("stops the stack on Ctrl-C or a termination signal", async () => {
    captureOutput();
    const { given, handlers, exits, killed } = stack();
    await e2e(["--app", "web"], given);
    killed.length = 0;
    handlers.get("SIGINT")?.();
    handlers.get("SIGTERM")?.();
    expect(exits).toEqual([130, 143]);
    expect(killed).toHaveLength(14);
  });

  it("refuses to start while something listens on the stack's ports", async () => {
    const printed = captureOutput();
    const { given, calls } = stack({ isListening: async (url) => url.includes(":3001") });
    expect(await e2e([], given)).toBe(1);
    expect(printed()).toContain("api: something already listens on localhost:3001");
    expect(calls).toEqual([]);
  });

  it("runs on this checkout's ports, and gives them to every service and suite", async () => {
    captureOutput();
    const asked: string[] = [];
    const moved = { API_PORT: "3101", WEB_PORT: "3100" };
    const { given, ran, environments } = stack({
      env: { ...moved, WEB_URL: "http://localhost:3100" },
      fetch: async (url) => {
        asked.push(url);
        return { ok: true };
      },
    });
    expect(await e2e([], given)).toBe(0);
    expect(asked).toContain("http://localhost:3101/health/dependencies");
    expect(asked).toContain("http://localhost:3100/healthz");
    for (const env of environments) {
      expect(env).toMatchObject({ ...moved, NODE_ENV: "test", WORKER_PORT: "3002" });
    }
    // The suites: Playwright, then the fuzzing, each told where the stack is.
    for (const { env } of ran.slice(1)) {
      expect(env).toMatchObject({ ...moved, WEB_URL: "http://localhost:3100" });
    }
  });

  it("gives the run demo guests and a demo account's password when it has none, the same to every service and suite", async () => {
    captureOutput();
    const { given, ran, environments } = stack();
    expect(await e2e([], given)).toBe(0);
    const [password] = environments.map((env) => env.DEMO_PASSWORD);
    expect(password).toMatch(/^[\w-]{40,}$/);
    for (const env of [...environments, ...ran.slice(1).map((options) => options.env ?? {})]) {
      expect(env.DEMO_PASSWORD).toBe(password);
      expect(env.DEMO_GUESTS).toBe("on");
    }
    // The checkout's own, when its .env has one.
    const own = stack({ env: { DEMO_PASSWORD: "this-checkouts-demo-password" } });
    await e2e(["--app", "web"], own.given);
    expect(own.environments[0]?.DEMO_PASSWORD).toBe("this-checkouts-demo-password");
    // And its own choice of demo guests.
    const off = stack({ env: { DEMO_GUESTS: "off" } });
    await e2e(["--app", "web"], off.given);
    expect(off.environments[0]?.DEMO_GUESTS).toBe("off");
  });

  it("knows no port that .env.example doesn't name", () => {
    expect(() => stackPorts({}, new Map())).toThrow("API_PORT is in neither");
  });

  it("refuses an unknown app, and stops when a build fails", async () => {
    const printed = captureOutput();
    expect(await e2e(["--app", "desktop"], stack().given)).toBe(1);
    expect(printed()).toContain("--app is web or fuzz");
    const broken = stack({ run: fakeRun(() => ({ status: 5 })).run });
    expect(await e2e([], broken.given)).toBe(5);
    expect(broken.started).toEqual([]);
    const killed = stack({ run: fakeRun(() => ({ status: null })).run });
    expect(await e2e([], killed.given)).toBe(1);
  });
});

describe("whether a service's port is taken", () => {
  it("connects to the URL's host and port", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    expect(await listeningAt(`http://127.0.0.1:${port}/health`)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    expect(await listeningAt(`http://127.0.0.1:${port}/health`)).toBe(false);
  });
});
