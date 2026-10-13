/**
 * Every procedure that changes something declares its rate limit, or why it has none
 * (ProcedureMeta in ./base.ts). The API applies what's declared (apps/api
 * src/rpc/procedures.ts), so a limit can't be written down here and not enforced.
 */
import { isContractProcedure, oc } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { base, type ProcedureMeta, type RateLimit } from "./base";
import { contract } from "./index";

interface Described {
  path: string;
  method: string;
  meta: ProcedureMeta;
  errors: string[];
}

type Procedure = {
  "~orpc": { meta: unknown; route: { method?: string }; errorMap: object };
};

const describeProcedure = (path: string, procedure: Procedure): Described => ({
  path,
  // oRPC's default for a procedure without a route: a mutation.
  method: procedure["~orpc"].route.method ?? "POST",
  meta: procedure["~orpc"].meta as ProcedureMeta,
  errors: Object.keys(procedure["~orpc"].errorMap),
});

/** Every procedure in a contract router, by its dotted path. */
function proceduresOf(router: object, prefix = ""): Described[] {
  return Object.entries(router).flatMap(([key, child]: [string, object]) =>
    isContractProcedure(child)
      ? [describeProcedure(`${prefix}${key}`, child)]
      : proceduresOf(child, `${prefix}${key}.`),
  );
}

/** The procedures that change something without a limit or a reason for none. */
const unlimitedMutations = (router: object) =>
  proceduresOf(router)
    .filter(({ method, meta }) => method !== "GET" && !meta.rateLimit)
    .map(({ path }) => path);

const limits = () =>
  proceduresOf(contract).flatMap(({ path, meta, errors }) =>
    meta.rateLimit && !("exempt" in meta.rateLimit)
      ? [{ path, limit: meta.rateLimit, errors }]
      : [],
  );

describe("rate limits", () => {
  it("are declared by every procedure that changes something, or it says why not", () => {
    expect(unlimitedMutations(contract)).toEqual([]);
    for (const { path, meta } of proceduresOf(contract)) {
      if (meta.rateLimit && "exempt" in meta.rateLimit) {
        expect(meta.rateLimit.exempt.trim(), path).not.toBe("");
      }
    }
  });

  it("are missed whatever the method, and for a procedure without a route", () => {
    const router = {
      read: base.route({ method: "GET", path: "/things" }),
      nested: {
        remove: base.route({ method: "DELETE", path: "/things/{id}" }),
        limited: base
          .meta({ rateLimit: { name: "t", points: 1, windowSeconds: 1, per: "user" } })
          .route({ method: "PATCH", path: "/things/{id}" }),
      },
      rpcOnly: oc,
    };
    expect(unlimitedMutations(router)).toEqual(["nested.remove", "rpcOnly"]);
  });

  it("that share a name share their settings, which are one allowance", () => {
    const byName = new Map<string, RateLimit>();
    for (const { path, limit } of limits()) {
      const first = byName.get(limit.name) ?? limit;
      byName.set(limit.name, first);
      expect(limit, `${path} (${limit.name})`).toEqual(first);
    }
  });

  it("per organization are only on procedures that act in one", () => {
    const outside = limits()
      .filter(
        ({ limit, errors }) => limit.per === "org" && !errors.includes("NO_ACTIVE_ORGANIZATION"),
      )
      .map(({ path }) => path);
    expect(outside).toEqual([]);
  });
});
