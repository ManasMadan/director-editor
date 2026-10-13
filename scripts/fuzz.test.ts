import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiToken, type Fuzz, fuzz } from "./fuzz";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const SECRET = "test-secret-not-a-real-one";
const ME = { id: "user-1", activeOrganizationId: "org-1" };

/** A checkout with a two-operation API (and its endless stream), and the users' cookies. */
function checkout(cookies: string[] = ["better-auth.session_token=one", "s=two=2"]) {
  const root = mkdtempSync(join(tmpdir(), "fuzz-"));
  mkdirSync(join(root, "apps/api"), { recursive: true });
  const op = (operationId: string) => ({ operationId });
  const paths = {
    "/todos": { get: op("todo.list"), post: op("todo.create") },
    "/realtime": { get: op("realtime.subscribe") },
  };
  writeFileSync(join(root, "apps/api/openapi.json"), JSON.stringify({ paths }));
  const sessions = join(root, "sessions.json");
  writeFileSync(sessions, JSON.stringify(cookies));
  return { root, sessions };
}

function stack(overrides: Partial<Fuzz> = {}, answer?: Parameters<typeof fakeRun>[0]) {
  const commands = fakeRun(answer);
  const asked: { url: string; cookie: string | undefined }[] = [];
  const given: Partial<Fuzz> = {
    run: commands.run,
    fetch: async (url, init) => {
      asked.push({ url, cookie: init.headers.cookie });
      return Response.json(ME);
    },
    env: { AI_SERVICE_SECRET: SECRET },
    ...checkout(),
    ...overrides,
  };
  return { given, calls: commands.calls, options: commands.options, asked };
}

function claims(token: string) {
  const [header = "", payload = "", signature] = token.split(".");
  const expected = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  expect(signature).toBe(expected);
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}

describe("the fuzz run", () => {
  it("signs in a user per operation, then fuzzes the AI service and each operation as its own user", async () => {
    captureOutput();
    const { given, calls, options, asked } = stack();
    expect(await fuzz(given)).toBe(0);
    const run = "uvx schemathesis@4.29.3 --config-file schemathesis.toml run";
    expect(calls).toEqual([
      "bunx turbo run load:users --filter=@repo/api",
      `${run} apps/ai/openapi.json --url http://localhost:8000`,
      `${run} apps/api/openapi.json --url http://localhost:3001/api/v1 --include-operation-id todo.list`,
      `${run} apps/api/openapi.json --url http://localhost:3001/api/v1 --include-operation-id todo.create`,
    ]);
    // Two users: the endless stream isn't fuzzed.
    expect(options[0]?.env?.LOAD_USERS).toBe("2");
    expect(asked).toEqual([
      { url: "http://localhost:3001/api/v1/me", cookie: "better-auth.session_token=one" },
    ]);
    // Each cookie's value, everything after its name.
    expect(options.slice(1).map((o) => o.env?.FUZZ_SESSION)).toEqual(["one", "one", "two=2"]);
    expect(options[1]?.cwd).toBe(given.root);
    const token = String(options[1]?.env?.AI_TOKEN);
    expect(claims(token)).toMatchObject({ iss: "api", aud: "ai", sub: "user-1", org: "org-1" });
  });

  it("names what failed, and still runs the rest", async () => {
    const printed = captureOutput();
    const { given, calls } = stack({}, (line) => {
      if (line.includes("apps/ai/")) {
        return { status: 1 };
      }
      if (line.endsWith("todo.list")) {
        return { status: null };
      }
      return undefined;
    });
    expect(await fuzz(given)).toBe(1);
    expect(calls).toHaveLength(4);
    expect(printed()).toContain("the AI service: see its run above");
    expect(printed()).toContain("todo.list: see its run above");
    expect(printed()).not.toContain("todo.create");
  });

  it("needs the AI service's secret", async () => {
    const printed = captureOutput();
    const { given, calls } = stack({ env: {} });
    expect(await fuzz(given)).toBe(1);
    expect(calls).toEqual([]);
    expect(printed()).toContain("AI_SERVICE_SECRET is unset");
  });

  it("stops when the users can't be signed in", async () => {
    captureOutput();
    const failing = stack({}, (line) => (line.includes("load:users") ? { status: 3 } : undefined));
    expect(await fuzz(failing.given)).toBe(3);
    const killed = stack({}, (line) =>
      line.includes("load:users") ? { status: null } : undefined,
    );
    expect(await fuzz(killed.given)).toBe(1);
    expect(killed.calls).toHaveLength(1);
  });

  it("says how to start the stack when the API doesn't answer, or refuses the session", async () => {
    const printed = captureOutput();
    const down = stack({ fetch: () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(await fuzz(down.given)).toBe(1);
    expect(printed()).toContain("The API doesn't answer at http://localhost:3001");
    const refused = stack({
      fetch: async () => new Response(null, { status: 401 }),
      ...checkout([]),
    });
    expect(await fuzz(refused.given)).toBe(1);
    expect(refused.calls).toHaveLength(1);
  });
});

describe("the AI service's token", () => {
  it("is signed with the secret, names the user and workspace, and lives two minutes", () => {
    const token = claims(aiToken(SECRET, "user-1", "org-1", 1_700_000_000_500));
    expect(token).toEqual({
      iss: "api",
      aud: "ai",
      sub: "user-1",
      org: "org-1",
      iat: 1_700_000_000,
      exp: 1_700_000_120,
    });
  });
});
