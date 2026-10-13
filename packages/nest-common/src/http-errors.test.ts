import { HttpException, Logger } from "@nestjs/common";
import { Prisma } from "@repo/db";
import Fastify from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AppError } from "./errors";
import { codeForStatus, handleHttpError } from "./http-errors";

const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

/** A raw Fastify app whose one route throws `error`, with the shared error handler. */
async function answer(error: unknown) {
  const app = Fastify();
  app.setErrorHandler(handleHttpError);
  app.get("/fail", async () => {
    throw error;
  });
  const response = await app.inject({ method: "GET", url: "/fail" });
  await app.close();
  return { status: response.statusCode, headers: response.headers, body: response.json() };
}

afterAll(() => logged.mockRestore());

describe("HTTP errors", () => {
  it("names each status by the catalog, and anything else by its class", () => {
    expect(codeForStatus(404)).toBe("NOT_FOUND");
    expect(codeForStatus(413)).toBe("PAYLOAD_TOO_LARGE");
    expect(codeForStatus(418)).toBe("BAD_REQUEST");
    expect(codeForStatus(502)).toBe("INTERNAL");
  });

  it("answers an AppError with its code and params, in the contract's shape", async () => {
    const { status, body } = await answer(
      new AppError("RATE_LIMITED", { params: { retryAfterSeconds: 3 } }),
    );
    expect(status).toBe(429);
    expect(body).toMatchObject({
      defined: true,
      code: "RATE_LIMITED",
      status: 429,
      message: "RATE_LIMITED",
      data: { params: { retryAfterSeconds: 3 }, requestId: expect.any(String) },
    });
  });

  it("answers Prisma's meaningful errors, Nest's and Fastify's by their status", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    expect((await answer(conflict)).body.code).toBe("CONFLICT");
    expect((await answer(new HttpException("gone", 404))).body.code).toBe("NOT_FOUND");
    const tooLarge = Object.assign(new Error("body too large"), { statusCode: 413 });
    expect((await answer(tooLarge)).body.code).toBe("PAYLOAD_TOO_LARGE");
    expect(logged).not.toHaveBeenCalled();
  });

  it("answers anything else as INTERNAL, logged, without saying what broke", async () => {
    const { status, body } = await answer(new Error("database password is hunter2"));
    expect(status).toBe(500);
    expect(body.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/fail",
        err: expect.objectContaining({ message: expect.any(String) }),
      }),
      "request failed",
    );
  });

  it("passes on when to come back, from an error that says so", async () => {
    const busy = Object.assign(new Error("Service Unavailable"), {
      statusCode: 503,
      headers: { "retry-after": "5" },
    });
    const { status, headers, body } = await answer(busy);
    expect(status).toBe(503);
    expect(headers["retry-after"]).toBe("5");
    expect(body.code).toBe("SERVICE_UNAVAILABLE");
  });
});
