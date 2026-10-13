import { describe, expect, expectTypeOf, it } from "vitest";
import { AppError, type ErrorCode, isAppError } from "./errors";

describe("AppError", () => {
  it("takes its status from the catalog, and the params it's given", () => {
    const error = new AppError("RATE_LIMITED", { params: { retryAfterSeconds: 30 } });
    expect(error.status).toBe(429);
    expect(error.params).toEqual({ retryAfterSeconds: 30 });
    expect(new AppError("TODO_NOT_FOUND").params).toEqual({});
  });

  it("must be given the params its code's message needs (a type error otherwise)", () => {
    type Takes<C extends ErrorCode, A extends unknown[]> =
      A extends ConstructorParameters<typeof AppError<C>> ? true : false;
    expectTypeOf<Takes<"TODO_NOT_FOUND", ["TODO_NOT_FOUND"]>>().toEqualTypeOf<true>();
    expectTypeOf<
      Takes<"RATE_LIMITED", ["RATE_LIMITED", { params: { retryAfterSeconds: number } }]>
    >().toEqualTypeOf<true>();
    expectTypeOf<Takes<"RATE_LIMITED", ["RATE_LIMITED"]>>().toEqualTypeOf<false>();
    expectTypeOf<
      Takes<"RATE_LIMITED", ["RATE_LIMITED", { params: { wrong: number } }]>
    >().toEqualTypeOf<false>();
  });

  it("tells an expected failure from any other error", () => {
    expect(isAppError(new AppError("TODO_NOT_FOUND"))).toBe(true);
    expect(isAppError(new Error("TODO_NOT_FOUND"))).toBe(false);
    expect(isAppError({ code: "TODO_NOT_FOUND", status: 404 })).toBe(false);
  });
});
