/**
 * Starts what the browser tests talk to: two builds of the real API, one with every
 * optional feature on (billing against the fake Stripe, files on the local RustFS, the
 * AI stand-in, Google sign-in) and one with every feature off except captcha, both on one
 * cloned database. The browser reaches them on its own origin, through the proxy in
 * vitest.config.ts, exactly like the site does through the gateway.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createTestDatabase, prepareTemplate } from "@repo/db/testing";
import { startFakeStripe } from "@repo/fake-stripe";
import { startFakeAi } from "./fake-ai";
import { API, CAPTCHA, REDIS_URL, type Services, SITE, STRIPE, VAPID_PUBLIC_KEY } from "./services";

const ROOT = join(import.meta.dirname, "../../..");
const API_DIR = join(ROOT, "apps/api");

/**
 * The API exits when this process does, even if it's killed before its teardown runs:
 * its stdin is a pipe from here, which closes then.
 */
const EXIT_WITH_PARENT =
  "--import=data:text/javascript,process.stdin.on('end',()=>process.exit()).resume()";

async function waitUntilReady(url: string, child: ChildProcess, log: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the API exited early; see ${log}`);
    }
    const ok = await fetch(`${url}/health/ready`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the API at ${url} never became ready; see ${log}`);
}

// Both browser projects list this setup; the services start once for the two of them.
const shared = globalThis as { webTestServices?: Promise<Services>; webTestUsers?: number };

export default async function setup() {
  shared.webTestServices ??= start();
  shared.webTestUsers = (shared.webTestUsers ?? 0) + 1;
  const services = await shared.webTestServices;
  return async () => {
    shared.webTestUsers = (shared.webTestUsers ?? 1) - 1;
    if (shared.webTestUsers === 0) {
      await services.close();
    }
  };
}

async function start(): Promise<Services> {
  // The API runs as it does in production: its own build, in its own process (it reads
  // its environment once, so each set of features needs a process of its own). Built
  // for this run only, so runs side by side (or `bun dev`'s watcher) never share a build.
  const dist = join(API_DIR, "node_modules/.cache", `web-tests-${process.pid}`);
  const build = spawnSync("bunx", ["tsdown", "--out-dir", dist, "--logLevel", "warn"], {
    cwd: API_DIR,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error("building apps/api failed");
  }

  await prepareTemplate();
  const database = await createTestDatabase();
  const stripe = await startFakeStripe({
    secretKey: STRIPE.secretKey,
    webhookSecret: STRIPE.webhookSecret,
    // Subscriptions are set up in the database by the tests; Stripe's events go nowhere.
    webhookUrl: "http://127.0.0.1:9/",
    prices: {
      [STRIPE.monthly]: { interval: "month", unitAmount: 1_200 },
      [STRIPE.yearly]: { interval: "year", unitAmount: 12_000 },
    },
  });
  const ai = await startFakeAi();

  const logs = join(ROOT, "logs");
  mkdirSync(logs, { recursive: true });
  const common = {
    NODE_ENV: "test" as const,
    LOG_LEVEL: "warn",
    LOAD_SHEDDING: "off",
    // Two APIs per run, and other suites share the database server.
    API_DATABASE_POOL_MAX: "4",
    // The web app sends no version, so this only affects tests that send an older one.
    MINIMUM_CLIENT_VERSION: "1.0.0",
    API_DATABASE_URL: database.urlFor("app_api"),
    REDIS_URL,
    VAPID_PUBLIC_KEY,
  };
  const off = {
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    TURNSTILE_SITE_KEY: "",
    TURNSTILE_SECRET_KEY: "",
    S3_BUCKET: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_PRICE_PRO_MONTHLY: "",
    STRIPE_PRICE_PRO_YEARLY: "",
    STRIPE_API_URL: "",
    AI_URL: "",
    AI_SERVICE_SECRET: "",
  };
  const variants = {
    full: {
      ...off,
      GOOGLE_CLIENT_ID: "web-tests.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "web-tests-secret",
      S3_BUCKET: process.env.S3_BUCKET ?? "uploads",
      STRIPE_SECRET_KEY: STRIPE.secretKey,
      STRIPE_PRICE_PRO_MONTHLY: STRIPE.monthly,
      STRIPE_PRICE_PRO_YEARLY: STRIPE.yearly,
      STRIPE_API_URL: stripe.url,
      AI_URL: ai.url,
      AI_SERVICE_SECRET: ai.secret,
    },
    bare: {
      ...off,
      TURNSTILE_SITE_KEY: CAPTCHA.siteKey,
      TURNSTILE_SECRET_KEY: CAPTCHA.secretKey,
    },
  };

  const children: ChildProcess[] = [];
  for (const [name, env] of Object.entries(variants) as [keyof typeof API, object][]) {
    const log = join(logs, `web-tests-api-${name}-${process.pid}.log`);
    const out = openSync(log, "w");
    const child = spawn(
      process.execPath,
      ["--enable-source-maps", EXIT_WITH_PARENT, join(dist, "main.mjs")],
      {
        cwd: API_DIR,
        env: {
          ...process.env,
          ...common,
          ...env,
          PORT: String(API[name].port),
          WEB_URL: SITE[name].url,
          BETTER_AUTH_URL: SITE[name].url,
        },
        stdio: ["pipe", out, out],
      },
    );
    children.push(child);
    await waitUntilReady(API[name].url, child, log);
  }

  return {
    databaseUrl: database.urlFor("postgres"),
    stripeUrl: stripe.url,
    async close() {
      await Promise.all(
        children.map(
          (child) =>
            new Promise((resolve) => {
              child.once("exit", resolve);
              child.kill("SIGTERM");
            }),
        ),
      );
      await stripe.close();
      await ai.close();
      await database.drop();
      rmSync(dist, { recursive: true, force: true });
    },
  };
}
