/**
 * Property-based tests of the API and the AI service from their OpenAPI documents
 * (apps/api/openapi.json, apps/ai/openapi.json), with Schemathesis: it sends each
 * operation requests generated from its schema, valid and invalid, and fails on a server
 * error or on a response whose status, content type or body the document doesn't
 * declare. The checks, a fixed seed and the cap on examples per operation are in
 * schemathesis.toml, so a run is the same every time and bounded. Against a running stack:
 *
 *   bun run test:fuzz             the stack you run (`bun dev`, and the AI service:
 *                                 `bun run --cwd apps/ai dev`)
 *   bun run test:e2e --app fuzz   builds and starts the stack itself, then this (CI)
 *
 * Each API operation runs on its own, as a signed-in user of its own (apps/api's
 * `load:users`): most writes share one per-user rate limit, which would otherwise answer
 * 429 to nearly everything after the first few operations. The AI service is called the
 * way the API calls it, with a token signed with AI_SERVICE_SECRET for the first user.
 *
 * Needs uv: uvx runs the pinned Schemathesis locally; nothing is uploaded anywhere.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { stackPorts } from "./e2e";
import { fail, ROOT, type Run, runMain, runSync } from "./lib";

// renovate: datasource=pypi depName=schemathesis
const SCHEMATHESIS = "schemathesis@4.29.3";

/** Event streams that never end: Schemathesis would wait for the body until it timed out. */
const ENDLESS = new Set(["realtime.subscribe"]);

/** The longest-lived token the AI service accepts (apps/ai/app/auth.py); a run takes seconds. */
const AI_TOKEN_SECONDS = 120;

const operations = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.object({ operationId: z.string() }))),
});
const me = z.object({ id: z.string(), activeOrganizationId: z.string() });

/** What the run touches; the tests replace them. */
export interface Fuzz {
  run: Run;
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
  env: Record<string, string | undefined>;
  /** Where `load:users` writes the users' session cookies. */
  sessions: string;
  root: string;
}

const REAL: Fuzz = {
  run: runSync,
  fetch,
  env: process.env,
  sessions: join(ROOT, "load/.sessions.json"),
  root: ROOT,
};

/** A token like the one the API signs for each call to the AI service (packages/ai-client). */
export function aiToken(secret: string, userId: string, orgId: string, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = {
    iss: "api",
    aud: "ai",
    sub: userId,
    org: orgId,
    iat,
    exp: iat + AI_TOKEN_SECONDS,
  };
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

/** Fuzzes the AI service, then each API operation; 0 when none failed. */
export async function fuzz(given: Partial<Fuzz> = {}): Promise<number> {
  const { run, env, root, ...deps } = { ...REAL, ...given };
  const secret = env.AI_SERVICE_SECRET;
  if (!secret) {
    fail("AI_SERVICE_SECRET is unset: the AI service's routes need a token signed with it.");
    return 1;
  }
  const { API_PORT, AI_PORT } = stackPorts(env);
  const document = operations.parse(
    JSON.parse(readFileSync(join(root, "apps/api/openapi.json"), "utf8")),
  );
  const ids = Object.values(document.paths)
    .flatMap((item) => Object.values(item).map(({ operationId }) => operationId))
    .filter((id) => !ENDLESS.has(id));

  const signedIn = run("bunx", ["turbo", "run", "load:users", "--filter=@repo/api"], {
    cwd: root,
    stdio: "inherit",
    env: { ...env, LOAD_USERS: String(ids.length) },
  });
  if (signedIn.status !== 0) {
    return signedIn.status ?? 1;
  }
  const cookies = z.array(z.string()).parse(JSON.parse(readFileSync(deps.sessions, "utf8")));
  const sessions = cookies.map((cookie) => cookie.slice(cookie.indexOf("=") + 1));

  const api = `http://localhost:${API_PORT}`;
  const answer = await deps
    .fetch(`${api}/api/v1/me`, { headers: { cookie: cookies[0] ?? "" } })
    .catch(() => undefined);
  if (!answer?.ok) {
    fail(
      `The API doesn't answer at ${api}: start the stack (bun dev), or use test:e2e --app fuzz.`,
    );
    return 1;
  }
  const user = me.parse(await answer.json());

  // Schemathesis reads both projects' settings on every run, so both variables are set.
  const token = aiToken(secret, user.id, user.activeOrganizationId);
  const schemathesis = (document: string, url: string, extra: string[], session = sessions[0]) =>
    run(
      "uvx",
      [SCHEMATHESIS, "--config-file", "schemathesis.toml", "run", document, "--url", url, ...extra],
      { cwd: root, stdio: "inherit", env: { ...env, AI_TOKEN: token, FUZZ_SESSION: session } },
    ).status ?? 1;

  const failed: string[] = [];
  if (schemathesis("apps/ai/openapi.json", `http://localhost:${AI_PORT}`, []) !== 0) {
    failed.push("the AI service");
  }
  for (const [index, id] of ids.entries()) {
    const args = ["--include-operation-id", id];
    if (schemathesis("apps/api/openapi.json", `${api}/api/v1`, args, sessions[index]) !== 0) {
      failed.push(id);
    }
  }
  for (const name of failed) {
    fail(`${name}: see its run above`);
  }
  return failed.length > 0 ? 1 : 0;
}

await runMain(import.meta, fuzz);
