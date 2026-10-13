/**
 * The k6 load test (load/api.ts), run in Bun with k6's modules stood in for: its profiles,
 * and what each scenario requests and checks. k6 itself runs it in `bun run test:load`.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import { ROOT } from "./lib";

type Answer = { status: number; body: string };
type Request = { method: string; url: string; body?: string; headers?: object };

const todo = (title: string, extra = {}) => ({
  id: "t1",
  title,
  completed: false,
  version: 1,
  ...extra,
});

/** What the stand-ins saw, and how the next request is answered. */
const k6 = {
  requests: [] as Request[],
  checks: {} as Record<string, boolean>,
  answer: (_request: Request): Answer => ({ status: 200, body: "{}" }),
  sessions: [] as string[],
};

const call =
  (method: string) =>
  (url: string, ...rest: unknown[]) => {
    const [body, params] = method === "GET" ? [undefined, rest[0]] : rest;
    const { headers } = (params ?? {}) as { headers?: object };
    const request = { method, url, body: typeof body === "string" ? body : undefined, headers };
    k6.requests.push(request);
    return k6.answer(request);
  };

/** k6's `new SharedArray(name, make)`: what `make` returns, shared between virtual users. */
function SharedArray(_name: string, make: () => string[]) {
  k6.sessions = make();
  return k6.sessions;
}

mock.module("k6", () => ({
  check: (response: Answer, named: Record<string, (r: Answer) => boolean>) =>
    Object.entries(named).every(([name, test]) => {
      k6.checks[name] = test(response);
      return k6.checks[name];
    }),
  fail: (message: string) => {
    throw new Error(message);
  },
}));
mock.module("k6/data", () => ({
  SharedArray,
}));
mock.module("k6/execution", () => ({
  default: { vu: { idInTest: 2 }, scenario: { iterationInTest: 7 } },
}));
mock.module("k6/http", () => ({
  default: {
    get: call("GET"),
    post: call("POST"),
    patch: call("PATCH"),
    del: call("DELETE"),
    expectedStatuses: (...statuses: number[]) => ({ statuses }),
  },
}));
Object.assign(globalThis, {
  __ENV: { API_PORT: "3001" },
  open: (path: string) => (path === "./.sessions.json" ? '["cookie-1","cookie-2"]' : ""),
});
// Typed for k6, which Bun's tsconfig doesn't load: imported by path.
const script = await import(join(ROOT, "load/api.ts"));

beforeEach(() => {
  k6.requests = [];
  k6.checks = {};
  k6.sessions.splice(0, k6.sessions.length, "cookie-1", "cookie-2");
});

describe("the load test's settings", () => {
  it("needs the API's address, and takes BASE_URL over this checkout's port", () => {
    expect(() => script.baseUrl({})).toThrow("Set BASE_URL, or API_PORT");
    expect(script.baseUrl({ API_PORT: "3001" })).toBe("http://host.docker.internal:3001");
    expect(script.baseUrl({ BASE_URL: "https://api.test/", API_PORT: "1" })).toBe(
      "https://api.test",
    );
  });

  it("runs the smoke profile by default", () => {
    expect(script.options.scenarios).toEqual(script.scenariosFor({}));
    expect(script.scenariosFor({}).read).toMatchObject({ rate: 4, duration: "30s" });
  });

  it("ramps to TARGET_RPS and holds it for DURATION with the load profile", () => {
    const { read, write } = script.scenariosFor({
      PROFILE: "load",
      TARGET_RPS: "100",
      DURATION: "30m",
    });
    expect(read.stages).toEqual([
      { target: 80, duration: "1m" },
      { target: 80, duration: "30m" },
      { target: 0, duration: "30s" },
    ]);
    expect([read.preAllocatedVUs, read.maxVUs, write.stages[0].target]).toEqual([16, 160, 5]);
    expect(script.scenariosFor({ PROFILE: "load" }).read.stages[1]).toEqual({
      target: 160,
      duration: "5m",
    });
    expect(() => script.scenariosFor({ PROFILE: "spike" })).toThrow('Unknown PROFILE "spike"');
  });

  it("takes only a list of session cookies", () => {
    expect(script.cookiesIn('["a","b"]')).toEqual(["a", "b"]);
    for (const text of ['{"a":1}', '["ok", 2]']) {
      expect(() => script.cookiesIn(text)).toThrow("must be a JSON list of session cookies");
    }
  });
});

describe("the load test's scenarios", () => {
  it("stops before the run without sessions, or when the API refuses them", () => {
    script.setup();
    expect(k6.requests[0]).toMatchObject({
      url: "http://host.docker.internal:3001/api/v1/todos",
      headers: { cookie: "cookie-1" },
    });
    k6.answer = () => ({ status: 401, body: "" });
    expect(() => script.setup()).toThrow("answered 401");
    k6.sessions.length = 0;
    expect(() => script.setup()).toThrow("has no sessions");
  });

  it("reads only the virtual user's own workspace", () => {
    let titles = ["load-2 a", "load-2 b"];
    k6.answer = () => ({
      status: 200,
      body: JSON.stringify({ items: titles.map((title) => todo(title)) }),
    });
    script.read();
    expect(k6.requests[0]?.headers).toEqual({ cookie: "cookie-2" });
    expect(k6.checks).toEqual({ "list: 200": true, "list: only this workspace": true });
    titles = ["load-1 someone else's"];
    script.read();
    expect(k6.checks["list: only this workspace"]).toBe(false);
  });

  it("fails an iteration whose answer isn't the API's shape", () => {
    k6.answer = () => ({ status: 200, body: "[1]" });
    expect(() => script.read()).toThrow("not a page of todos");
    k6.answer = () => ({
      status: 200,
      body: JSON.stringify({ items: [todo("load-2"), { id: 1 }] }),
    });
    expect(() => script.read()).toThrow("not a page of todos");
    k6.answer = () => ({ status: 201, body: "{}" });
    expect(() => script.write()).toThrow("not a todo");
    k6.sessions.length = 0;
    expect(() => script.read()).toThrow("no session");
  });

  it("creates, completes, is refused a stale version, and deletes", () => {
    k6.answer = (request) => {
      if (request.method === "POST") {
        return { status: 201, body: JSON.stringify(todo("load-2 7")) };
      }
      if (request.method === "PATCH") {
        return request.body?.includes('"completed":false')
          ? { status: 409, body: "{}" }
          : { status: 200, body: JSON.stringify(todo("load-2 7", { completed: true })) };
      }
      return { status: 204, body: "" };
    };
    script.write();
    expect(k6.requests.map(({ method, url }) => `${method} ${url.split(":3001")[1]}`)).toEqual([
      "POST /api/v1/todos",
      "PATCH /api/v1/todos/t1",
      "PATCH /api/v1/todos/t1",
      "DELETE /api/v1/todos/t1",
    ]);
    expect(k6.requests[0]?.body).toBe('{"title":"load-2 7"}');
    expect(k6.checks).toEqual({
      "create: 201": true,
      "complete: 200": true,
      "stale: 409": true,
      "delete: 204": true,
    });
  });

  it("stops the iteration when the create fails", () => {
    k6.answer = () => ({ status: 500, body: "" });
    script.write();
    expect(k6.requests).toHaveLength(1);
  });
});
