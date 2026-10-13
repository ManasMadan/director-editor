/**
 * Starts one built image the way a cluster would and checks it answers:
 * `bun scripts/image-smoke.ts <image>` (CI's images job, after the build and the scan).
 *
 * Each service runs with the least configuration it boots with, against the Postgres and
 * Valkey on localhost (CI's service containers, or `bun run db:up` with migrations
 * applied), on the host's network. It must then say both answer (/health/dependencies),
 * and the api serve one RPC and the web app one page. The migrate image instead applies
 * the migrations and must exit 0. The container is removed afterwards, and its logs are
 * printed when a check fails.
 *
 * Needs Docker and the image, tagged boilerplate/<image>:dev (`docker buildx bake <image>
 * --load`).
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fail, ok, runMain, runSync } from "./lib";

const secret = () => randomBytes(32).toString("base64");
const database = (role: string) => `postgresql://${role}:${role}@127.0.0.1:5432/app`;
const REDIS_URL = "redis://127.0.0.1:6379";

/** What each image needs to boot, where it listens and what it must answer. */
export const IMAGES: Record<
  string,
  { env: () => Record<string, string>; port?: number; paths: string[] }
> = {
  api: {
    port: 3001,
    env: () => ({
      PORT: "3001",
      API_DATABASE_URL: database("app_api"),
      REDIS_URL,
      BETTER_AUTH_SECRET: secret(),
      BETTER_AUTH_URL: "http://127.0.0.1:3001",
      WEB_URL: "http://127.0.0.1:3000",
      UNSUBSCRIBE_SECRET: secret(),
      ENCRYPTION_KEYS: `smoke:${secret()}`,
    }),
    paths: ["/health/dependencies", "/api/v1/system"],
  },
  worker: {
    port: 3002,
    env: () => ({
      PORT: "3002",
      WORKER_DATABASE_URL: database("app_worker"),
      WORKER_DATABASE_DIRECT_URL: database("app_worker"),
      REDIS_URL,
    }),
    paths: ["/health/dependencies"],
  },
  notifications: {
    port: 3003,
    env: () => ({
      PORT: "3003",
      NOTIFICATIONS_DATABASE_URL: database("app_notifications"),
      REDIS_URL,
      // Production's rules for submission (credentials, TLS); nothing is sent.
      SMTP_URL: "smtps://smoke:smoke-password@127.0.0.1:1465",
      EMAIL_FROM: "Smoke <no-reply@example.com>",
      WEB_URL: "http://127.0.0.1:3000",
      UNSUBSCRIBE_SECRET: secret(),
    }),
    paths: ["/health/dependencies"],
  },
  webhooks: {
    port: 3004,
    env: () => ({
      PORT: "3004",
      WEBHOOKS_DATABASE_URL: database("app_webhooks"),
      REDIS_URL,
      ENCRYPTION_KEYS: `smoke:${secret()}`,
    }),
    paths: ["/health/dependencies"],
  },
  // A page that renders on the server without the api (the legal pages).
  web: {
    port: 3000,
    env: () => ({ WEB_URL: "http://127.0.0.1:3000" }),
    paths: ["/healthz", "/privacy"],
  },
  ai: {
    port: 8000,
    env: () => ({ AI_DATABASE_URL: database("app_ai"), REDIS_URL, AI_SERVICE_SECRET: secret() }),
    paths: ["/health/dependencies"],
  },
  migrate: { env: () => ({ MIGRATOR_DATABASE_URL: database("migrator") }), paths: [] },
};

// Each request gives up on its own: a port that accepts and never answers mustn't hang.
export const request = (url: string): Promise<{ status: number }> =>
  fetch(url, { signal: AbortSignal.timeout(5000) });

/** An image with no port (migrate): runs to the end; the exit code. */
function runToExit(image: string, args: string[], tag: string, run: typeof runSync) {
  const status = run("docker", [...args, "--rm", tag], { stdio: "inherit" }).status;
  if (status === 0) {
    ok(`${image}: exited 0`);
  } else {
    fail(`${image}: exited ${status}`);
  }
  return status === 0 ? 0 : 1;
}

/** The last status `url` answered, polling every `pollMs` until a 200 or `timeoutMs`. */
async function statusOf(url: string, get: typeof request, timeoutMs: number, pollMs: number) {
  const deadline = Date.now() + timeoutMs;
  let status = 0;
  while (status !== 200 && Date.now() < deadline) {
    status = await get(url).then(
      (response) => response.status,
      () => 0,
    );
    if (status !== 200) {
      await sleep(pollMs);
    }
  }
  return status;
}

/** Smoke-tests `image`; the exit code. Waits up to `timeoutMs` for each path. */
export async function smoke(
  image: string | undefined = process.argv[2],
  { run = runSync, get = request, timeoutMs = 120_000, pollMs = 2000 } = {},
): Promise<number> {
  const spec = image ? IMAGES[image] : undefined;
  if (!image || !spec) {
    console.error(`usage: bun scripts/image-smoke.ts <${Object.keys(IMAGES).join("|")}>`);
    return 2;
  }
  const name = `smoke-${image}`;
  const env = Object.entries(spec.env()).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const args = ["run", "--name", name, "--network", "host", ...env];
  const tag = `boilerplate/${image}:dev`;
  if (!spec.port) {
    return runToExit(image, args, tag, run);
  }

  const started = run("docker", [...args, "--detach", tag]);
  if (started.status !== 0) {
    fail(`${image}: didn't start: ${started.stderr.trim()}`);
    return 1;
  }
  let passed = true;
  for (const path of spec.paths) {
    const status = await statusOf(`http://127.0.0.1:${spec.port}${path}`, get, timeoutMs, pollMs);
    if (status === 200) {
      ok(`${image}: ${path} → 200`);
    } else {
      fail(`${image}: ${path} → ${status}`);
      passed = false;
    }
  }
  if (!passed) {
    run("docker", ["logs", name], { stdio: "inherit" });
  }
  run("docker", ["rm", "--force", name]);
  return passed ? 0 : 1;
}

await runMain(import.meta, smoke);
