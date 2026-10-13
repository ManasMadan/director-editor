/**
 * Load test for the API's hot path: signed-in users reading and changing their
 * workspace's todos over REST (/api/v1), which exercises the session check, the
 * membership re-check, row-level security, optimistic versions and the outbox on every
 * request. Runs in k6 (Docker, nothing to install) against a running API:
 *
 *   bun run test:load                    smoke: a few requests a second, 30s (CI runs this)
 *   PROFILE=load bun run test:load       ramps to TARGET_RPS (default 200) and holds it
 *   PROFILE=load DURATION=30m bun run test:load     soak
 *
 * Users come from load/.sessions.json, which `test:load` fills first (see
 * apps/api/src/load-users.ts). For another environment, set BASE_URL and run it with
 * that environment's variables, so the sessions are made in its database. The run fails when a threshold below fails: that's the latency and error
 * budget this service promises, so raise it only on purpose.
 */
import { check, fail } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import http, { type RefinedResponse } from "k6/http";
import type { Options, Scenario } from "k6/options";

/** Where the API is: BASE_URL, or the API's port on this checkout (API_PORT, from .env). */
export function baseUrl(env: Record<string, string | undefined>) {
  if (!env.BASE_URL && !env.API_PORT) {
    throw new Error("Set BASE_URL, or API_PORT (.env has it)");
  }
  return (env.BASE_URL ?? `http://host.docker.internal:${env.API_PORT}`).replace(/\/$/, "");
}

/**
 * The scenarios of PROFILE: smoke (a few requests a second), or load (ramps to TARGET_RPS
 * and holds it for DURATION). Reads outnumber writes about 4 to 1 in a todo app; each
 * write iteration makes 4 requests.
 */
export function scenariosFor(env: Record<string, string | undefined>): Record<string, Scenario> {
  const profile = env.PROFILE ?? "smoke";
  const target = Number(env.TARGET_RPS ?? 200);
  const duration = env.DURATION ?? "5m";
  if (profile === "smoke") {
    return {
      read: constant("read", 4),
      write: constant("write", 1),
    };
  }
  if (profile === "load") {
    return {
      read: ramp("read", target * 0.8, duration),
      write: ramp("write", (target * 0.2) / 4, duration),
    };
  }
  throw new Error(`Unknown PROFILE "${profile}" (smoke or load)`);
}

function constant(exec: string, rate: number): Scenario {
  return {
    executor: "constant-arrival-rate",
    exec,
    rate,
    timeUnit: "1s",
    duration: "30s",
    preAllocatedVUs: 4,
  };
}

function ramp(exec: string, rate: number, duration: string): Scenario {
  return {
    executor: "ramping-arrival-rate",
    exec,
    startRate: 0,
    timeUnit: "1s",
    preAllocatedVUs: Math.ceil(rate / 5),
    maxVUs: Math.ceil(rate * 2),
    stages: [
      { target: Math.ceil(rate), duration: "1m" },
      { target: Math.ceil(rate), duration },
      { target: 0, duration: "30s" },
    ],
  };
}

/** The session cookies in load/.sessions.json's text. */
export function cookiesIn(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  const cookies = isList(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  if (!isList(parsed) || cookies.length !== parsed.length) {
    throw new Error("load/.sessions.json must be a JSON list of session cookies");
  }
  return cookies;
}

const BASE_URL = baseUrl(__ENV);
const sessions = new SharedArray("sessions", () => cookiesIn(open("./.sessions.json")));

export const options: Options = {
  scenarios: scenariosFor(__ENV),
  thresholds: {
    // Any failed request (including 503 from load shedding) counts against the budget.
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    "http_req_duration{scenario:read}": ["p(95)<250", "p(99)<500"],
    "http_req_duration{scenario:write}": ["p(95)<400", "p(99)<800"],
  },
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

// Only on requests with a body: Fastify refuses an empty body declared as JSON.
const JSON_BODY = { "content-type": "application/json" };

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  version: number;
}

// k6 can't load zod, so the API's answers are checked by hand.
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTodo(value: unknown): value is Todo {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.completed === "boolean" &&
    typeof value.version === "number"
  );
}

/** The response's body as a todo; the iteration fails (and counts) when it isn't one. */
function todoOf(response: RefinedResponse<"text">): Todo {
  const body: unknown = JSON.parse(response.body);
  return isTodo(body) ? body : fail(`not a todo: ${response.body}`);
}

/** The response's body as a page of todos. */
function todosOf(response: RefinedResponse<"text">): Todo[] {
  const body: unknown = JSON.parse(response.body);
  const items = isRecord(body) && isList(body.items) ? body.items.filter(isTodo) : [];
  return isRecord(body) && isList(body.items) && items.length === body.items.length
    ? items
    : fail(`not a page of todos: ${response.body}`);
}

/** The virtual user's account: one of the prepared sessions, the same one every time. */
function user(index = (exec.vu.idInTest - 1) % sessions.length) {
  return {
    prefix: `load-${index + 1} `,
    headers: { cookie: sessions[index] ?? fail(`no session ${index}`) },
  };
}

export function setup() {
  if (sessions.length === 0) {
    fail("load/.sessions.json has no sessions");
  }
  const response = http.get(`${BASE_URL}/api/v1/todos`, { headers: user(0).headers });
  if (response.status !== 200) {
    fail(
      `GET /api/v1/todos answered ${response.status}; is the API up and are the sessions fresh?`,
    );
  }
}

export function read() {
  const { prefix, headers } = user();
  const response = http.get(`${BASE_URL}/api/v1/todos?limit=20`, {
    headers,
    tags: { name: "list" },
  });
  check(response, {
    "list: 200": (r) => r.status === 200,
    // Row-level security under concurrency: only this user's workspace, ever.
    "list: only this workspace": (r) =>
      r.status === 200 && todosOf(r).every((todo) => todo.title.startsWith(prefix)),
  });
}

export function write() {
  const { prefix, headers } = user();
  const created = http.post(
    `${BASE_URL}/api/v1/todos`,
    JSON.stringify({ title: `${prefix}${exec.scenario.iterationInTest}` }),
    { headers: { ...headers, ...JSON_BODY }, tags: { name: "create" } },
  );
  if (!check(created, { "create: 201": (r) => r.status === 201 })) {
    return;
  }
  const todo = todoOf(created);

  const done = http.patch(
    `${BASE_URL}/api/v1/todos/${todo.id}`,
    JSON.stringify({ completed: true, version: todo.version }),
    { headers: { ...headers, ...JSON_BODY }, tags: { name: "complete" } },
  );
  check(done, { "complete: 200": (r) => r.status === 200 && todoOf(r).completed });

  // A stale version is refused, not applied: optimistic concurrency holds under load.
  const stale = http.patch(
    `${BASE_URL}/api/v1/todos/${todo.id}`,
    JSON.stringify({ completed: false, version: todo.version }),
    {
      headers: { ...headers, ...JSON_BODY },
      tags: { name: "stale" },
      responseCallback: http.expectedStatuses(409),
    },
  );
  check(stale, { "stale: 409": (r) => r.status === 409 });

  const removed = http.del(`${BASE_URL}/api/v1/todos/${todo.id}`, null, {
    headers,
    tags: { name: "delete" },
  });
  check(removed, { "delete: 204": (r) => r.status === 204 });
}
