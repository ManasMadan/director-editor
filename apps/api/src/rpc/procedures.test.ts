import { ORPCError, ValidationError } from "@orpc/server";
import type { ApiKeyId, OrgId, UserId } from "@repo/contracts/ids";
import { Prisma } from "@repo/db";
import { AppError } from "@repo/nest-common";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { type OrgCaller, rateLimitKey, toContractError } from "./procedures";

describe("who an organization-scoped call acts as", () => {
  it("hands routers branded ids, so a service can't get them swapped", () => {
    expectTypeOf<OrgCaller["orgId"]>().toEqualTypeOf<OrgId>();
    expectTypeOf<OrgCaller["userId"]>().toEqualTypeOf<UserId>();
    expectTypeOf<OrgCaller["apiKeyId"]>().toEqualTypeOf<ApiKeyId | null>();
  });
});

describe("errors from procedures", () => {
  it("logs an AppError of 500 or more, with its cause: it's our fault", () => {
    const log = vi.fn();
    const cause = new TypeError("the AI service answered something else");
    const mapped = toContractError(new AppError("UPSTREAM_UNAVAILABLE", { cause }), log);
    expect(mapped.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ cause }), "error");
  });

  it("logs a client error only at debug, and only when it has a cause", () => {
    const log = vi.fn();
    toContractError(new AppError("TODO_NOT_FOUND"), log);
    expect(log).not.toHaveBeenCalled();
    toContractError(new AppError("TODO_NOT_FOUND", { cause: new Error("row gone") }), log);
    expect(log).toHaveBeenCalledWith(expect.any(AppError), "debug");
  });

  it("logs anything else as an error and hides it behind INTERNAL", () => {
    const log = vi.fn();
    const mapped = toContractError(new Error("boom"), log);
    expect(mapped.code).toBe("INTERNAL");
    expect(log).toHaveBeenCalledWith(expect.any(Error), "error");
  });

  it("turns a Prisma error a client can act on into its catalog code", () => {
    const log = vi.fn();
    const unique = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    expect(toContractError(unique, log).code).toBe("CONFLICT");
    expect(log).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("sends validation problems as codes and paths, never English messages", () => {
    const issues = [
      { message: "Too short", path: ["items", { key: "title" }, 0], code: "too_small" },
      { message: "Not JSON", path: [Symbol("hidden")], code: "custom" },
      { message: "Something's off" },
    ];
    const invalid = new ORPCError("BAD_REQUEST", {
      cause: new ValidationError({ message: "Input validation failed", issues }),
    });
    const mapped = toContractError(invalid, vi.fn());
    expect(mapped.code).toBe("VALIDATION_FAILED");
    expect(mapped.data).toMatchObject({
      params: {},
      issues: [
        { path: ["items", "title", 0], code: "too_small" },
        { path: ["Symbol(hidden)"], code: "custom" },
        { path: [], code: "invalid" },
      ],
    });
  });

  it("keeps an oRPC error with a catalog code, and its params", () => {
    const log = vi.fn();
    const bare = toContractError(new ORPCError("TODO_NOT_FOUND", { status: 404 }), log);
    expect(bare).toMatchObject({ code: "TODO_NOT_FOUND", status: 404, data: { params: {} } });
    const withParams = toContractError(
      new ORPCError("RATE_LIMITED", { data: { params: { retryAfterSeconds: 3 } } }),
      log,
    );
    expect(withParams.data).toMatchObject({ params: { retryAfterSeconds: 3 } });
    expect(log).not.toHaveBeenCalled();
  });

  it("hides an oRPC error with a code the catalog doesn't have", () => {
    const log = vi.fn();
    expect(toContractError(new ORPCError("TEAPOT"), log).code).toBe("INTERNAL");
    expect(log).toHaveBeenCalledWith(expect.any(ORPCError), "error");
  });
});

describe("rate limit keys", () => {
  const limit = { name: "test", points: 1, windowSeconds: 1 } as const;

  it("count per user or per workspace, and never a workspace limit outside one", () => {
    expect(rateLimitKey({ ...limit, per: "user" }, { user: "u-1", org: "o-1" })).toBe("u-1");
    expect(rateLimitKey({ ...limit, per: "org" }, { user: "u-1", org: "o-1" })).toBe("o-1");
    expect(() => rateLimitKey({ ...limit, per: "org" }, { user: "u-1" })).toThrow(
      'limit "test" is per org',
    );
  });
});
