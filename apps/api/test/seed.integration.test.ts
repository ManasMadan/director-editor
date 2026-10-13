/**
 * The API's commands: the demo seed (bun run db:seed) leaves what using the app would, and
 * only once; the load-test users; re-encrypting secrets; and the server's own entry point.
 */

import { existsSync } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { factories } from "@repo/db/testing";
import { DATABASE, type Database } from "@repo/nest-common";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Auth } from "../src/auth/auth.module";
import { DEMO_PASSWORD, DEMO_PEOPLE, seedDemo } from "../src/seed/demo";
import { loadEmail, signInLoadUsers } from "../src/seed/load-users";
import { createSession, type Harness, startApi } from "./harness";

let harness: Harness;
let seed: () => ReturnType<typeof seedDemo>;
/** The auth provider's token in the harness's own module graph (commands reload theirs). */
let AUTH: symbol;
beforeAll(async () => {
  harness = await startApi(2);
  // Imported only now: these load the API's configuration, which startApi points at
  // this file's own database first.
  ({ AUTH } = await import("../src/auth/auth.module"));
  const { TodoService } = await import("../src/modules/todo");
  seed = () =>
    seedDemo({
      auth: harness.app.get<Auth>(AUTH),
      database: harness.app.get<Database>(DATABASE),
      todos: harness.app.get(TodoService),
    });
});
afterAll(() => harness?.close());

/** Runs a command's entry point in this process, with what it logs. */
async function command(entry: string, env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const module = await import(entry);
    return { module, lines: log.mock.calls.map((call) => String(call[0])) };
  } catch (thrown) {
    return { thrown, errors: error.mock.calls.map((call) => String(call[0])) };
  } finally {
    log.mockRestore();
    error.mockRestore();
    vi.unstubAllEnvs();
  }
}

/** Production, as far as the configuration's own checks let a test go. */
const PRODUCTION = { NODE_ENV: "production", WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "" };

/** process.exit, stopped short so the refusal can be seen. */
function refusingExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("demo seed", () => {
  it("`bun run db:seed` seeds once, then says it already has", async () => {
    const first = await command("../src/seed");
    expect(first.lines).toEqual([
      "Seeded.",
      expect.stringContaining("/sign-in with any of:"),
      ...DEMO_PEOPLE.map((person) => `  ${person.email} / ${DEMO_PASSWORD}`),
    ]);
    const again = await command("../src/seed");
    expect(again.lines?.[0]).toBe("Already seeded. `bun run db:reset` starts over.");
  });

  it("refuses to seed in production", async () => {
    const exit = refusingExit();
    const run = await command("../src/seed", PRODUCTION);
    expect(exit).toHaveBeenCalledWith(1);
    expect(run.errors).toEqual(["The demo seed is for development only."]);
  });

  it("creates verified users who can sign in and see their workspaces' todos", async () => {
    // Seeded by the command above.
    expect(await seed()).toBeNull();
    const created = await harness.app
      .get<Database>(DATABASE)
      .write.organization.findUniqueOrThrow({ where: { slug: "acme" } })
      .then((team) => ({ teamId: team.id }));

    const session = createSession(harness);
    const signIn = await session.auth("/sign-in/email", {
      email: DEMO_PEOPLE[0].email,
      password: DEMO_PASSWORD,
    });
    expect(signIn.status).toBe(200);
    const personal = await session.rpc.todo.list({});
    expect(personal.items.map((todo) => todo.title).sort()).toEqual([
      "Connect an app",
      "Invite a teammate",
      "Try the assistant",
    ]);

    await session.auth("/organization/set-active", { organizationId: created?.teamId });
    const team = await session.rpc.todo.list({});
    expect(team.items.map((todo) => [todo.title, todo.completed]).sort()).toEqual([
      ["Plan the launch", false],
      ["Set up billing", true],
      ["Write the changelog", false],
    ]);
  });

  it("changes nothing when run again", async () => {
    expect(await seed()).toBeNull();
    const database = harness.app.get<Database>(DATABASE);
    expect(
      await database.write.user.count({ where: { email: { endsWith: "@example.com" } } }),
    ).toBe(2);
  });
});

describe("load-test users", () => {
  const signIn = (count: number) =>
    signInLoadUsers(
      { auth: harness.app.get<Auth>(AUTH), database: harness.app.get<Database>(DATABASE) },
      count,
    );

  it("signs in verified users with their own workspace, reusing them on the next run", async () => {
    const first = await signIn(3);
    expect(first).toHaveLength(3);
    for (const cookie of first) {
      const response = await fetch(`${harness.baseUrl}/api/v1/todos`, { headers: { cookie } });
      expect(response.status).toBe(200);
    }
    const again = await signIn(3);
    expect(again).toHaveLength(3);
    expect(again).not.toEqual(first);
    const users = await harness.app
      .get<Database>(DATABASE)
      .write.user.findMany({ where: { email: { in: [1, 2, 3].map(loadEmail) } } });
    expect(users.map((user) => user.emailVerified)).toEqual([true, true, true]);
  });

  it("stops at a load-test user who can't sign in with the load-test password", async () => {
    const database = harness.app.get<Database>(DATABASE);
    // Someone made load-4 by hand, without that password.
    await factories(database.write).user({ email: loadEmail(4) });
    await expect(signIn(4)).rejects.toThrow(`Signing in ${loadEmail(4)} failed (401)`);
  });
});

describe("the load-test users command", () => {
  const output = join(import.meta.dirname, "../../../load/.sessions.json");
  const kept = `${output}.kept`;

  it("writes a session cookie per user for k6", async () => {
    // A developer's own file is put back afterwards.
    const had = existsSync(output);
    if (had) {
      await rename(output, kept);
    }
    try {
      const run = await command("../src/load-users", { LOAD_USERS: "2" });
      expect(run.lines).toEqual([`2 signed-in users written to ${output}`]);
      const sessions = JSON.parse(await readFile(output, "utf8")) as string[];
      expect(sessions).toEqual([
        expect.stringMatching(/session_token=/),
        expect.stringMatching(/session_token=/),
      ]);
    } finally {
      await rm(output, { force: true });
      if (had) {
        await rename(kept, output);
      }
    }
  });

  it("refuses to run in production", async () => {
    const exit = refusingExit();
    const run = await command("../src/load-users", PRODUCTION);
    expect(exit).toHaveBeenCalledWith(1);
    expect(run.errors).toEqual(["Load-test users are for development and test environments only."]);
  });
});

describe("the re-encryption command", () => {
  it("says what it moved, and that better-auth's values stay with a single secret", async () => {
    const single = await command("../src/reencrypt", { BETTER_AUTH_SECRETS: "" });
    expect(single.lines).toEqual([
      expect.stringMatching(
        /^Re-encrypted \d+ accounts, \d+ two-factor settings, \d+ signing keys and \d+ webhook endpoints\.$/,
      ),
      "BETTER_AUTH_SECRETS isn't set, so better-auth's values have one key and were left as they are.",
    ]);
    const versioned = await command("../src/reencrypt", {
      BETTER_AUTH_SECRETS: `1:${"v".repeat(40)}`,
    });
    expect(versioned.lines).toHaveLength(1);
  });
});

describe("the server's entry points", () => {
  it("start the API listening, with telemetry off without an endpoint", async () => {
    await command("../src/telemetry", { OTEL_EXPORTER_OTLP_ENDPOINT: undefined });
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    const { module } = await command("../src/main", { PORT: String(port) });
    const app = (module as typeof import("../src/main")).app;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/health/live`)).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
