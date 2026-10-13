/**
 * Prisma's errors that mean something to a client, as catalog errors: a unique
 * constraint lost to a concurrent write is a conflict, a row gone between reading and
 * writing is not found, a transaction or connection that timed out is the service being
 * busy. Everything else stays an internal error. Both the API's procedures and the HTTP
 * error filter apply it, so a repository needn't catch them one by one (a call that
 * means something more specific, like PHONE_NUMBER_TAKEN, still catches its own).
 */
import { Prisma } from "@repo/db";
import { AppError } from "./errors";

export function fromPrismaError(error: unknown): AppError | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return undefined;
  }
  switch (error.code) {
    case "P2002": // unique constraint
    case "P2034": // write conflict or deadlock; retrying may succeed
      return new AppError("CONFLICT", { cause: error });
    case "P2025": // the record the operation depends on isn't there
      return new AppError("NOT_FOUND", { cause: error });
    case "P2024": // timed out getting a connection from the pool
    case "P2028": // transaction API error (an interactive transaction timed out)
      return new AppError("SERVICE_UNAVAILABLE", { cause: error });
    default:
      return undefined;
  }
}
