/**
 * The one logger configuration for every TypeScript service.
 *
 * - Production: one JSON object per line on stdout, which every log platform (Loki,
 *   CloudWatch, Datadog, GCP Logging) ingests without parsing rules.
 * - Development: human-readable, colorized output via pino-pretty.
 * - Always: `service` on every line, ISO timestamps, `level` as a string, and secrets
 *   redacted before they leave the process.
 *
 * Python services emit the same shape via structlog (apps/ai/app/logging.py), so one
 * query works across languages: `{service="api", level="error"}`.
 */
import { type LoggerOptions, pino, stdSerializers } from "pino";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface LoggerConfig {
  service: string;
  level?: LogLevel;
  pretty?: boolean;
}

/**
 * Paths removed from every line: credentials in headers, and request bodies whole (a
 * sign-in's holds the password or code, a take's its signed URL; nothing logs one on
 * purpose, and one logged by mistake must not leak).
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "req.body",
  "body",
];

const CENSOR = "[redacted]";
const MAX_DEPTH = 8;

/**
 * What names a credential, in a field (censored wherever it appears, at any depth: a
 * job payload nests the code as `job.data.data.otp`, which path-based redaction would
 * miss) and in a URL's query. Names are compared in lower case with `-` and `_` taken
 * out, so apiKey, api_key and X-Api-Key are one name. A field is one when its name ends
 * in "token" (not "tokens": the counts of tokens a model used are kept) or holds one of
 * these. apps/ai's app/log.py has the same rules.
 */
const SECRET_FIELD_PARTS = [
  "password",
  "secret",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "backupcode",
];
/** A query parameter is one when its name holds one of these, or is a short one below. */
const SECRET_PARAM_PARTS = ["signature", "credential", "token", "secret", "password", "apikey"];
/** A presigned URL's signature and key, an API key, an OAuth code. */
const SECRET_PARAMS = new Set(["sig", "key", "code", "otp"]);
/**
 * A query parameter anywhere in a string: a URL, an error's message, a stack trace. A
 * name never holds `?` or `&`, so each attempt stops at the next separator and a long
 * run of them can't make the match quadratic.
 */
const QUERY_PARAM = /([?&])([^=?&#\s"'<>]+)=([^&#\s"'<>]*)/g;

const normalized = (name: string) => name.toLowerCase().replaceAll(/[-_]/g, "");

/** Whether a field of this name holds a credential, whatever its casing style. */
export function isSecretField(name: string): boolean {
  const key = normalized(name);
  return (
    key === "otp" || key.endsWith("token") || SECRET_FIELD_PARTS.some((part) => key.includes(part))
  );
}

function isSecretParam(name: string): boolean {
  const key = normalized(name);
  return SECRET_PARAMS.has(key) || SECRET_PARAM_PARTS.some((part) => key.includes(part));
}

/**
 * A string as logged: each secret query parameter's value censored, everything else
 * kept, so a presigned URL keeps its path and a stack trace naming one its other lines.
 */
function scrubText(value: string): string {
  return value.replaceAll(QUERY_PARAM, (match, separator: string, name: string) =>
    isSecretParam(name) ? `${separator}${name}=${CENSOR}` : match,
  );
}

/**
 * Returns a copy of `value` with every credential censored. An Error becomes what pino
 * writes of one (type, message, stack, cause, its own fields), scrubbed like the rest:
 * its message can hold a signed URL as well as any string. Exported for tests.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return scrubText(value);
  }
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth + 1));
  }
  if (value instanceof Error) {
    return scrubFields(stdSerializers.err(value), depth);
  }
  return scrubFields(value, depth);
}

/** A copy of an object's fields, each credential censored. */
function scrubFields(value: object, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields: [string, unknown][] = Object.entries(value);
  for (const [key, inner] of fields) {
    out[key] = isSecretField(key) ? CENSOR : scrub(inner, depth + 1);
  }
  return out;
}

export function loggerOptions({
  service,
  level = "info",
  pretty = false,
}: LoggerConfig): LoggerOptions {
  return {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      // A second pass on top of `redact`: redact only knows fixed paths, scrub finds a
      // sensitive key at any depth. It copies each object, which costs about 0.7µs on a
      // typical job line (1.6µs against 1.0µs, measured on an M-series laptop), far
      // below the write itself.
      // pino hands this an object, never an Error (it puts an error under `err`).
      log: (object) => scrubFields(object, 0),
    },
    // The message is no field, so `formatters.log` never sees it: scrubbed on its way in.
    hooks: {
      logMethod(args, method) {
        for (const [index, arg] of args.entries()) {
          if (typeof arg === "string") {
            args[index] = scrubText(arg);
          }
        }
        method.apply(this, args);
      },
    },
    // pino's own `err` serializer would take the scrubbed copy for an Error of type
    // "Object": this one scrubs a real Error and keeps an already scrubbed one as it is.
    serializers: { err: scrub },
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    ...(pretty && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          singleLine: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname,service",
        },
      },
    }),
  };
}

export function createLogger(config: LoggerConfig) {
  return pino(loggerOptions(config));
}
