/**
 * Rules every procedure of the router follows, checked over all of them:
 *
 *   - it checks who's calling (a session, or an API key where the contract allows one),
 *     unless it's one of the public endpoints listed here, each with its reason;
 *   - the error codes its contract declares are ones its code can throw (the other way
 *     round, an undeclared code, is refused at runtime outside production: strictErrors
 *     in rpc.routes.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import type { INestApplication } from "@nestjs/common";
import { call, isProcedure } from "@orpc/server";
import { COMMON_ERRORS, contract, type ProcedureMeta } from "@repo/contracts/api";
import { isAppError, type Redis } from "@repo/nest-common";
import { describe, expect, it } from "vitest";
import type { Auth } from "../auth/auth";
import type { Memberships } from "../auth/memberships";
import { createProcedures } from "./procedures";
import { createRouter } from "./router";

/** Anyone may call these, signed in or not. */
const PUBLIC: Record<string, string> = {
  "system.info":
    "Clients read it before anyone signs in: the enabled features, the oldest supported app version, and the captcha and push keys.",
  "system.alerting":
    "The uptime check outside the cluster reads it, signed out: only ok, stale or off, from a verdict cached for 30 seconds.",
  "notifications.unsubscribe":
    "Opened from an email's unsubscribe link, often signed out: the signed token in the link is what authorizes it.",
};

type Procedure = Parameters<typeof call>[0] & { "~orpc": { meta: unknown } };

/** Every procedure of a router, by its dotted path. */
function proceduresOf(router: object, prefix = ""): [string, Procedure][] {
  return Object.entries(router).flatMap(([key, child]: [string, object]) =>
    isProcedure(child) ? [[`${prefix}${key}`, child]] : proceduresOf(child, `${prefix}${key}.`),
  );
}

// No session behind any call, and nothing past the checks is reached: no services, and
// Redis only once a caller is known (their rate limit).
const auth = { api: { getSession: async () => null } } as unknown as Auth;
const router = createRouter(
  createProcedures(
    auth,
    {} as Memberships,
    () => Promise.reject(new Error("no API key is sent")),
    {} as Redis,
  ),
  { get: () => ({}) } as unknown as INestApplication,
);
const procedures = proceduresOf(router);

/** What a call without a session or key ends in: an error code, or "answered". */
async function anonymousCall(procedure: Procedure) {
  try {
    await call(procedure, undefined, { context: { headers: new Headers() } });
    return "answered";
  } catch (error) {
    return isAppError(error) ? error.code : "failed";
  }
}

describe("authorization", () => {
  it("refuses every call without a session, except the public endpoints", async () => {
    const open: string[] = [];
    for (const [path, procedure] of procedures) {
      if (!(path in PUBLIC) && (await anonymousCall(procedure)) !== "UNAUTHENTICATED") {
        open.push(path);
      }
    }
    expect(open).toEqual([]);
  });

  it("lists only public endpoints that exist and are open, and says why", async () => {
    const paths = new Map(procedures);
    for (const [path, reason] of Object.entries(PUBLIC)) {
      const procedure = paths.get(path);
      expect(procedure, path).toBeDefined();
      expect(await anonymousCall(procedure as Procedure), path).not.toBe("UNAUTHENTICATED");
      expect(reason.length, path).toBeGreaterThan(20);
      // Their builder doesn't know who's calling, so it can't apply a limit.
      const { rateLimit } = (procedure as Procedure)["~orpc"].meta as ProcedureMeta;
      expect(rateLimit === undefined || "exempt" in rateLimit, path).toBe(true);
    }
  });
});

describe("declared errors", () => {
  const modules = new URL("../modules/", import.meta.url);
  const sourceOf = (dir: string) =>
    readdirSync(new URL(`${dir}/`, modules), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => readFileSync(new URL(`${dir}/${file}`, modules), "utf8"))
      .join("\n");
  /** The module's own source and that of the modules it imports, transitively. */
  function reachable(dir: string, seen = new Set<string>()): string {
    seen.add(dir);
    const source = sourceOf(dir);
    const imported = [...source.matchAll(/from "\.\.\/([\w-]+)"/g)].map(
      (match) => match[1] as string,
    );
    return [
      source,
      ...imported.filter((name) => !seen.has(name)).map((name) => reachable(name, seen)),
    ].join("\n");
  }

  // Codes the builders throw (procedures.ts), and the routers that use such a builder.
  const BUILDER_CODES: Record<string, RegExp> = {
    NO_ACTIVE_ORGANIZATION: /\b(inOrg|orgAdmin|freshAdmin)\./,
    FRESH_SESSION_REQUIRED: /\b(fresh|freshAdmin)\.|requireFresh\(/,
  };
  const common = new Set<string>(COMMON_ERRORS);
  const thrownIn = (source: string) =>
    new Set([...source.matchAll(/"([A-Z][A-Z_]+)"/g)].map((match) => match[1] as string));

  it("knows every code the builders throw", () => {
    const source = readFileSync(new URL("./procedures.ts", import.meta.url), "utf8");
    const own = [...thrownIn(source)].filter((code) => !common.has(code));
    expect(own.sort()).toEqual(Object.keys(BUILDER_CODES).sort());
  });

  /** The codes a module's procedures declare that nothing it runs can throw. */
  const unthrownIn = (name: string, procedures: (typeof contract)[keyof typeof contract]) => {
    const dir = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const source = reachable(dir);
    const thrown = thrownIn(source);
    const all = Object.values(procedures);
    // An API key without the procedure's scope (modules/api-keys).
    if (all.some((procedure) => (procedure["~orpc"].meta as ProcedureMeta).apiKeyScope)) {
      thrown.add("API_KEY_SCOPE_MISSING");
    }
    for (const [code, builders] of Object.entries(BUILDER_CODES)) {
      if (builders.test(source)) {
        thrown.add(code);
      }
    }
    const declared = new Set(all.flatMap((procedure) => Object.keys(procedure["~orpc"].errorMap)));
    return [...declared]
      .filter((code) => !common.has(code) && !thrown.has(code))
      .map((code) => `${name}: ${code}`);
  };

  it("are codes each module can throw, beyond the ones any call can fail with", () => {
    const unthrown = Object.entries(contract).flatMap(([name, procedures]) =>
      unthrownIn(name, procedures),
    );
    expect(unthrown).toEqual([]);
  });
});
