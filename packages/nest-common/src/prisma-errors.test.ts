import { Prisma } from "@repo/db";
import { describe, expect, it } from "vitest";
import { fromPrismaError } from "./prisma-errors";

const prisma = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(`prisma ${code}`, { code, clientVersion: "test" });

describe("Prisma errors", () => {
  it.each([
    ["P2002", "CONFLICT"],
    ["P2034", "CONFLICT"],
    ["P2025", "NOT_FOUND"],
    ["P2024", "SERVICE_UNAVAILABLE"],
    ["P2028", "SERVICE_UNAVAILABLE"],
  ])("%s means %s to a client, with the original as the cause", (code, mapped) => {
    const error = prisma(code);
    const appError = fromPrismaError(error);
    expect(appError?.code).toBe(mapped);
    expect(appError?.cause).toBe(error);
  });

  it("leaves everything else alone (it stays an internal error)", () => {
    expect(fromPrismaError(prisma("P2003"))).toBeUndefined();
    expect(fromPrismaError(new Error("not Prisma's"))).toBeUndefined();
  });
});
