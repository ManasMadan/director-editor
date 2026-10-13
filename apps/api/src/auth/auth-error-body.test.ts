import { describe, expect, it } from "vitest";
import { authErrorBody } from "./auth.routes";

const body = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("better-auth's error bodies", () => {
  it("get the common envelope, keeping better-auth's code and message", () => {
    expect(
      authErrorBody(body({ code: "INVALID_EMAIL", message: "Invalid email" }), 400, "r1"),
    ).toEqual({
      defined: false,
      code: "INVALID_EMAIL",
      status: 400,
      message: "Invalid email",
      data: { params: {}, requestId: "r1" },
    });
  });

  it("leave OAuth's RFC-shaped errors, and anything else, as they are", () => {
    expect(
      authErrorBody(body({ error: "invalid_grant", error_description: "x" }), 400, "r1"),
    ).toBeNull();
    expect(authErrorBody(body({ message: "no code" }), 400, "r1")).toBeNull();
    expect(authErrorBody(Buffer.from("<html>"), 500, "r1")).toBeNull();
    expect(authErrorBody(body("a string"), 400, "r1")).toBeNull();
  });
});
