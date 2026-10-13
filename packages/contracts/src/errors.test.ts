/** The error body schema describes what oRPC actually sends, so other services can match it. */
import { ORPCError } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { errorResponse } from "./api/base";

describe("errorResponse", () => {
  it("is the shape of a contract error on the wire", () => {
    const body = new ORPCError("TODO_NOT_FOUND", {
      status: 404,
      data: { params: { id: "t-1" }, requestId: "r-1" },
    }).toJSON();
    expect(errorResponse.parse(body)).toEqual(body);
  });

  it("refuses a code outside the catalog", () => {
    const body = new ORPCError("TODO_NOT_FUOND", { status: 404, data: { params: {} } }).toJSON();
    expect(errorResponse.safeParse(body).success).toBe(false);
  });
});
