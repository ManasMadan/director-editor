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
  it("builds, starts every service, runs web, mobile, the load smoke and the fuzzing, then stops them", async () => {
    const printed = captureOutput();
    const { given, calls, started, killed } = stack();
    expect(await e2e([], given)).toBe(0);
    expect(calls).toEqual([
      "bunx turbo run build --filter=@repo/api --filter=@repo/worker --filter=@repo/notifications --filter=@repo/webhooks --filter=@repo/web",
      "bun run --cwd apps/mobile build:web",
      "bunx playwright test",
      "bunx playwright test",
      "bun run test:load",
      "bun run test:fuzz",
    ]);
    expect(started).toHaveLength(9);
    expect(started[0]).toBe(`${join(ROOT, "packages/fake-stripe")} run start`);
    expect(killed).toEqual(started.map((_, index) => -(1001 + index)));
    expect(printed()).toContain("mobile-web ready");
  });

  it("runs one app's suite with the rest of the arguments for Playwright", async () => {
    captureOutput();
    const { given, calls } = stack();
    expect(await e2e(["--app", "web", "e2e/auth.spec.ts"], given)).toBe(0);
    expect(calls.slice(2)).toEqual(["bunx playwright test e2e/auth.spec.ts"]);
  });

  it("leaves the load smoke to the first shard and the fuzzing to the second", async () => {
    captureOutput();
    const first = stack();
    await e2e(["--shard=1/4"], first.given);
    expect(first.calls.slice(4)).toEqual(["bun run test:load"]);
    const second = stack();
    await e2e(["--shard=2/4"], second.given);
    expect(second.calls.slice(2)).toEqual([
      "bunx playwright test --shard=2/4",
      "bunx playwright test --shard=2/4",
      "bun run test:fuzz",
    ]);
    const third = stack();
    await e2e(["--shard=3/4"], third.given);
    expect(third.calls.slice(4)).toEqual([]);
  });

  it("fuzzes from the root, with the stack's ports, as a test run", async () => {
    captureOutput();
    const { given, calls, ran } = stack();
    expect(await e2e(["--app", "fuzz"], given)).toBe(0);
    expect(calls.slice(2)).toEqual(["bun run test:fuzz"]);
    expect(ran[2]).toMatchObject({ cwd: ROOT, env: { NODE_ENV: "test", API_PORT: "3001" } });
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
    expect(await e2e(["--app", "mobile"], failing.given)).toBe(2);
    const crashed = stack({
      run: fakeRun((line) => (line.includes("test:load") ? { status: null } : {})).run,
    });
    expect(await e2e(["--app", "load"], crashed.given)).toBe(1);
  });

  it("shows the log of a service that exits or never becomes ready, and stops the rest", async () => {
    const printed = captureOutput();
    const exited = stack({
      start: () => ({ pid: 7, exitCode: 1 }),
    });
    expect(await e2e(["--app", "web"], exited.given)).toBe(1);
    expect(printed()).toContain("fake-stripe never became ready (logs/fake-stripe.log)");
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
    expect(killed).toHaveLength(18);
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
    const moved = { API_PORT: "3101", WEB_PORT: "3100", MOBILE_WEB_PORT: "3105" };
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
    expect(asked).toContain("http://127.0.0.1:12111/__fake/state");
    for (const env of environments) {
      expect(env).toMatchObject({ ...moved, NODE_ENV: "test", WORKER_PORT: "3002" });
      expect(env.APP_ORIGINS).toBe("http://localhost:3105");
    }
    // The suites: Playwright twice, then k6, each told where the stack is.
    for (const { env } of ran.slice(2)) {
      expect(env).toMatchObject({ ...moved, WEB_URL: "http://localhost:3100" });
    }
  });

  it("knows no port that .env.example doesn't name", () => {
    expect(() => stackPorts({}, new Map())).toThrow("STRIPE_FAKE_PORT is in neither");
  });

  it("refuses an unknown app, and stops when a build fails", async () => {
    const printed = captureOutput();
    expect(await e2e(["--app", "desktop"], stack().given)).toBe(1);
    expect(printed()).toContain("--app is web, mobile, load or fuzz");
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
