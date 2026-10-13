/**
 * One error body for every HTTP surface, the contract's (oRPC's error JSON, statuses
 * from the catalog): procedures produce it themselves, and this gives it to everything
 * else. Raw Fastify routes call `sendError`; createServer installs the handlers below,
 * so a malformed body, an oversized one, a wrong media type, an unknown route or an
 * error thrown in a raw route all answer in the same shape.
 *
 *   { defined: true, code: "NOT_FOUND", status: 404, message: "NOT_FOUND",
 *     data: { params: {}, requestId: "…" } }
 */
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { ERROR_CODES, type ErrorCode } from "@repo/contracts/errors";
import { fieldOf } from "@repo/contracts/objects";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isAppError } from "./errors";
import { describeError } from "./job-processor";
import { fromPrismaError } from "./prisma-errors";

type Params = Record<string, string | number>;

function errorBody(code: ErrorCode, params: Params = {}, requestId?: string) {
  return {
    defined: true,
    code,
    status: ERROR_CODES[code],
    message: code,
    data: { params, ...(requestId && { requestId }) },
  };
}

/** Answers with a catalog error, in the contract's shape. */
export function sendError(reply: FastifyReply, code: ErrorCode, params?: Params) {
  return reply
    .status(ERROR_CODES[code])
    .type("application/json")
    .send(errorBody(code, params, String(reply.request.id)));
}

/** The catalog code for an HTTP status nothing more specific explains. */
export function codeForStatus(status: number): ErrorCode {
  const byStatus: Record<number, ErrorCode> = {
    400: "BAD_REQUEST",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_SUPPORTED",
    408: "TIMEOUT",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    422: "VALIDATION_FAILED",
    429: "RATE_LIMITED",
    503: "SERVICE_UNAVAILABLE",
  };
  return byStatus[status] ?? (status >= 500 ? "INTERNAL" : "BAD_REQUEST");
}

/** What an error thrown outside a procedure means, as a catalog error. */
function toHttpError(error: unknown): { code: ErrorCode; params: Params } {
  const known = isAppError(error) ? error : fromPrismaError(error);
  if (known) {
    return { code: known.code, params: known.params };
  }
  if (error instanceof HttpException) {
    return { code: codeForStatus(error.getStatus()), params: {} };
  }
  const status = fieldOf(error, "statusCode");
  return { code: typeof status === "number" ? codeForStatus(status) : "INTERNAL", params: {} };
}

const log = new Logger("HttpErrors");

/** Answers any error as a catalog error; 5xx ones are logged. */
export function handleHttpError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const { code, params } = toHttpError(error);
  if (ERROR_CODES[code] >= 500) {
    log.error({ err: describeError(error), url: request.routeOptions.url }, "request failed");
  }
  // Load shedding says when to come back.
  const retryAfter = fieldOf(fieldOf(error, "headers"), "retry-after");
  if (retryAfter) {
    reply.header("retry-after", retryAfter);
  }
  return sendError(reply, code, params);
}

/** Nest's own responses (its controllers and its 404) in the same shape. */
@Catch()
export class ContractExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    return handleHttpError(
      exception,
      http.getRequest<FastifyRequest>(),
      http.getResponse<FastifyReply>(),
    );
  }
}
