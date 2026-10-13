/**
 * Runs the end-to-end suite against a stack it builds and starts itself, then stops it.
 * CI and local runs use this same script, so both test exactly what was just built.
 *
 *   bun run test:e2e                         every suite (web, mobile, the load smoke, the fuzzing)
 *   bun run test:e2e --app web e2e/assistant.spec.ts   one app; the rest goes to Playwright
 *   bun run test:e2e --app load              the k6 smoke run (load/api.ts) on its own
 *   bun run test:e2e --app fuzz              the API's and AI service's fuzzing (scripts/fuzz.ts)
 *   bun run test:e2e --shard=2/4             a quarter of the browser tests, as each CI runner does
 *
 * The mobile suite runs the app's screens rendered for the web (react-native-web),
 * served with the API on their own origin (apps/mobile/scripts/serve-web.ts). The load
 * smoke and the fuzzing run last, against the same stack, with the worker relaying what
 * the API writes.
 *
 * Every service listens on this checkout's port for it (its .env's `*_PORT`, else
 * .env.example's), so a checkout with its own stack (`bun run setup --stack <n>`) runs
 * its suite while another runs theirs. It refuses to start while anything already
 * listens on those ports: an older server would answer instead and the run would test
 * stale code. To iterate against a stack you are already running (`bun dev`), use
 * `bun run --cwd apps/web test:e2e`.
 *
 * Postgres, Valkey, Mailpit, RustFS and ClamAV come from `bun run db:up:full`
 * (CI starts its own); the services run as NODE_ENV=test, since production refuses the
 * local stand-ins the suite relies on. What runs is still the production build.
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ENV_EXAMPLE_PATH, fail, listening, ok, ROOT, readEnv, runMain, runSync } from "./lib";

/** The ports the run's services listen on, each one of .env.example's `*_PORT`. */
const PORTS = [
  "STRIPE_FAKE_PORT",
  "API_PORT",
  "WORKER_PORT",
  "NOTIFICATIONS_PORT",
  "WEBHOOKS_PORT",
  "AI_PORT",
  "WEB_PORT",
  "MOBILE_WEB_PORT",
] as const;
type Ports = Record<(typeof PORTS)[number], string>;

/**
 * This checkout's ports: `env`'s (the root .env's, which Bun loads for this script, or
 * CI's), else .env.example's. A checkout with its own stack has them moved in its .env
 * (`bun run setup --stack <n>`), so two checkouts' runs never meet.
 */
export function stackPorts(
  env: Record<string, string | undefined>,
  example = readEnv(ENV_EXAMPLE_PATH),
) {
  const port = (key: string) => {
    const value = env[key] || example.get(key);
    if (!value) {
      throw new Error(`${key} is in neither .env nor .env.example`);
    }
    return [key, value];
  };
  return Object.fromEntries(PORTS.map(port)) as Ports;
}

const local = (port: string, path: string) => `http://localhost:${port}${path}`;
const health = (port: string) => local(port, "/health/dependencies");

/** What the run starts, in order, and the URL that answers once each is ready. */
const services = (ports: Ports): { name: string; cwd: string; run: string[]; ready?: string }[] => [
  {
    name: "fake-stripe",
    cwd: "packages/fake-stripe",
    run: ["start"],
    ready: `http://127.0.0.1:${ports.STRIPE_FAKE_PORT}/__fake/state`,
  },
  { name: "api", cwd: "apps/api", run: ["start"], ready: health(ports.API_PORT) },
  { name: "worker", cwd: "apps/worker", run: ["start"], ready: health(ports.WORKER_PORT) },
  {
    name: "notifications",
    cwd: "apps/notifications",
    run: ["start"],
    ready: health(ports.NOTIFICATIONS_PORT),
  },
  { name: "webhooks", cwd: "apps/webhooks", run: ["start"], ready: health(ports.WEBHOOKS_PORT) },
  { name: "ai", cwd: "apps/ai", run: ["start"], ready: health(ports.AI_PORT) },
  { name: "ai-worker", cwd: "apps/ai", run: ["worker"] },
  { name: "web", cwd: "apps/web", run: ["start"], ready: local(ports.WEB_PORT, "/healthz") },
  {
    name: "mobile-web",
    cwd: "apps/mobile",
    run: ["serve:web"],
    ready: local(ports.MOBILE_WEB_PORT, "/healthz"),
  },
];
type Service = ReturnType<typeof services>[number];

const BUILT = ["@repo/api", "@repo/worker", "@repo/notifications", "@repo/webhooks", "@repo/web"];
const READY_TIMEOUT_MS = 90_000;

/** Whether something accepts connections at the URL's host and port. */
export const listeningAt = (url: string) => {
  const { hostname, port } = new URL(url);
  return listening(Number(port), 1000, hostname);
};

/** What the run starts and waits with; the tests replace them. */
export interface Stack {
  run: typeof runSync;
  start: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => Pick<ChildProcess, "pid" | "exitCode">;
  kill: (pid: number, signal: NodeJS.Signals) => unknown;
  isListening: (url: string) => Promise<boolean>;
  fetch: (url: string) => Promise<{ ok: boolean }>;
  sleep: (ms: number) => Promise<unknown>;
  onSignal: (signal: NodeJS.Signals, handler: () => void) => unknown;
  exit: (code: number) => unknown;
  logs: string;
  readyTimeoutMs: number;
  /** The environment the run starts from: Bun loads the root .env into it, CI sets its own. */
  env: Record<string, string | undefined>;
}

const REAL: Stack = {
  run: runSync,
  start: spawn,
  kill: process.kill.bind(process),
  isListening: listeningAt,
  fetch,
  sleep,
  onSignal: process.on.bind(process),
  exit: process.exit.bind(process),
  logs: join(ROOT, "logs"),
  readyTimeoutMs: READY_TIMEOUT_MS,
  env: process.env,
};

type Running = { name: string; process: Pick<ChildProcess, "pid" | "exitCode"> };

/** Whether `url` answers before the stack's timeout, as long as `child` keeps running. */
async function ready(stack: Stack, url: string, child: Pick<ChildProcess, "exitCode">) {
  const deadline = Date.now() + stack.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return false;
    }
    const response = await stack.fetch(url).catch(() => undefined);
    if (response?.ok) {
      return true;
    }
    await stack.sleep(500);
  }
  return false;
}

/** The services whose port something else already listens on, with that port's URL. */
async function busyServices(stack: Stack, all: Service[]) {
  const listeningNow = await Promise.all(
    all.map(async ({ name, ready }) =>
      ready && (await stack.isListening(ready)) ? { name, ready } : undefined,
    ),
  );
  return listeningNow.filter((s) => s !== undefined);
}

const SUITES = ["web", "mobile", "load", "fuzz"];
/**
 * Sharded (`--shard=2/4`, CI runs four), the browser suites split, and each of the others,
 * which aren't Playwright, runs on one shard only.
 */
const SHARD_OF: Partial<Record<string, string>> = { load: "1", fuzz: "2" };

/**
 * The suites `argv` asks for (`--app web|mobile|load|fuzz`, all of them by default) and
 * the arguments for Playwright; undefined when `--app` names something else.
 */
function suitesFor(argv: string[]) {
  const appFlag = argv.indexOf("--app");
  const playwrightArgs =
    appFlag === -1 ? argv : argv.filter((_, i) => i !== appFlag && i !== appFlag + 1);
  const shard = playwrightArgs
    .map((arg) => /^--shard=(\d+)\//.exec(arg)?.[1])
    .find((n) => n !== undefined);
  const everything = SUITES.filter((suite) => !shard || (SHARD_OF[suite] ?? shard) === shard);
  if (appFlag === -1) {
    return { apps: everything, playwrightArgs };
  }
  const app = argv[appFlag + 1];
  return app && SUITES.includes(app) ? { apps: [app], playwrightArgs } : undefined;
}

/** The production builds the stack runs; the exit code of the first that fails, or 0. */
function build(stack: Stack) {
  for (const [command = "", ...rest] of [
    ["bunx", "turbo", "run", "build", ...BUILT.map((p) => `--filter=${p}`)],
    ["bun", "run", "--cwd", "apps/mobile", "build:web"],
  ]) {
    const built = stack.run(command, rest, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...stack.env, NODE_ENV: "production" },
    });
    if (built.status !== 0) {
      return built.status ?? 1;
    }
  }
  return 0;
}

/** Stops every service still running. */
function stopAll(stack: Stack, running: Running[]) {
  for (const { process: child } of running) {
    // Each service runs in its own process group (bun → uv → python, for example).
    if (child.pid && child.exitCode === null) {
      try {
        stack.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
}

/** Starts every service, each logging to its own file, then waits until each is ready. */
async function startAll(stack: Stack, running: Running[], ports: Ports) {
  const all = services(ports);
  for (const service of all) {
    const log = openSync(join(stack.logs, `${service.name}.log`), "w");
    const child = stack.start("bun", ["run", ...service.run], {
      cwd: join(ROOT, service.cwd),
      // Each listens on its port (the package scripts read them); the mobile web build
      // signs users in from its own origin.
      env: {
        ...stack.env,
        ...ports,
        NODE_ENV: "test",
        APP_ORIGINS: local(ports.MOBILE_WEB_PORT, ""),
      },
      stdio: ["ignore", log, log],
      detached: true,
    });
    running.push({ name: service.name, process: child });
  }
  for (const [index, service] of all.entries()) {
    const child = running[index]?.process;
    if (!service.ready || !child) {
      continue;
    }
    if (!(await ready(stack, service.ready, child))) {
      const log = readFileSync(join(stack.logs, `${service.name}.log`), "utf8");
      console.error(log.split("\n").slice(-50).join("\n"));
      throw new Error(`${service.name} never became ready (logs/${service.name}.log)`);
    }
    ok(`${service.name} ready`);
  }
}

/** The suites that aren't Playwright: the package script each runs, and from where. */
const OWN_COMMANDS: Partial<Record<string, { cwd: string; script: string }>> = {
  load: { cwd: "load", script: "test:load" },
  fuzz: { cwd: ".", script: "test:fuzz" },
};

/** Runs each suite against the running stack; 0 when all pass, else a failing one's code. */
function runSuites(stack: Stack, apps: string[], playwrightArgs: string[], ports: Ports) {
  let status = 0;
  // The suites find the stack by its ports (the k6 smoke reaches the API on API_PORT).
  const env = { ...stack.env, ...ports };
  for (const app of apps) {
    const own = OWN_COMMANDS[app];
    const suite = own
      ? stack.run("bun", ["run", own.script], {
          cwd: join(ROOT, own.cwd),
          stdio: "inherit",
          env: { ...env, NODE_ENV: "test" },
        })
      : stack.run("bunx", ["playwright", "test", ...playwrightArgs], {
          cwd: join(ROOT, `apps/${app}`),
          stdio: "inherit",
          env,
        });
    if (suite.status !== 0) {
      status = suite.status ?? 1;
    }
  }
  return status;
}

/** Builds, starts the stack, runs the suites `argv` picks and stops it; the exit code. */
export async function e2e(
  argv = process.argv.slice(2),
  given: Partial<Stack> = {},
): Promise<number> {
  const stack = { ...REAL, ...given };
  const ports = stackPorts(stack.env);

  const busy = await busyServices(stack, services(ports));
  if (busy.length > 0) {
    for (const s of busy) {
      fail(`${s.name}: something already listens on ${new URL(s.ready).host}`);
    }
    console.error(
      "Stop the running stack first, or test against it with `bun run --cwd apps/web test:e2e`.",
    );
    return 1;
  }

  const suites = suitesFor(argv);
  if (!suites) {
    fail("--app is web, mobile, load or fuzz");
    return 1;
  }

  const built = build(stack);
  if (built !== 0) {
    return built;
  }

  mkdirSync(stack.logs, { recursive: true });
  const running: Running[] = [];
  stack.onSignal("SIGINT", () => {
    stopAll(stack, running);
    stack.exit(130);
  });
  stack.onSignal("SIGTERM", () => {
    stopAll(stack, running);
    stack.exit(143);
  });

  try {
    await startAll(stack, running, ports);
    return runSuites(stack, suites.apps, suites.playwrightArgs, ports);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    stopAll(stack, running);
  }
}

await runMain(import.meta, e2e);
