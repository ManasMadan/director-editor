/**
 * Environment fragments shared by every Nest service.
 *
 * Each service composes its own schema from these plus its specific variables:
 *
 *   export const env = createEnv({
 *     server: { ...coreEnv, ...databaseEnv, ...redisEnv, PORT: port(3001), MY_VAR: z.string() },
 *     runtimeEnv: withServicePort("MY"),
 *     emptyStringAsUndefined: true,
 *   });
 *
 * so a shared variable has one name, one validation rule and one default everywhere.
 */
import * as z from "zod";

/**
 * A comma-separated list: items trimmed, empty ones dropped ("a, b," → ["a", "b"]).
 * `.prefault("…")` gives it a value when unset; `.pipe(...)` checks the items.
 */
export const csv = z.string().transform((value) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
);

const nodeEnv = z.enum(["development", "test", "production"]).default("development");
const logLevel = z
  .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
  .default("info");

export const port = (fallback: number) =>
  z.coerce.number().int().min(1).max(65_535).default(fallback);

/**
 * The environment a service's schema reads, with PORT where this service listens: PORT
 * when it's set (the stack chart sets it), else the service's own variable from the
 * shared local .env (`API_PORT` for "API"), which `bun run setup --stack <n>` moves with
 * the checkout's other ports. With neither, the schema's `port(...)` default applies.
 */
export function withServicePort(service: string, env: NodeJS.ProcessEnv = process.env) {
  return { ...env, PORT: env.PORT || env[`${service}_PORT`] };
}

export const coreEnv = {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  /**
   * Which peers may set X-Forwarded-For / x-request-id. Comma-separated CIDRs or the
   * proxy-addr names `loopback`, `linklocal`, `uniquelocal`. The client IP drives rate
   * limits, lockout and audit logs, so trusting everyone would let any caller forge it.
   * Kubernetes: the gateway's pod range (the private `uniquelocal` ranges cover it).
   */
  TRUSTED_PROXIES: csv.prefault("loopback"),
  /**
   * Shed load (503) when the process is saturated. Off only where many instances share
   * one machine on purpose, like the integration tests, whose parallel test files would
   * otherwise trip each other's pressure checks.
   */
  LOAD_SHEDDING: z
    .enum(["on", "off"])
    .default("on")
    .transform((value) => value === "on"),
  /** Git SHA of the running build, stamped by CI into the image. */
  RELEASE: z.string().default("dev"),
};

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

/**
 * Database variables for one service. Every service connects as its own Postgres role
 * (least privilege, enforced by GRANTs and row-level security), so each has its own
 * URL: `databaseEnv("API")` gives `API_DATABASE_URL` and `API_DATABASE_POOL_MAX`.
 * Locally they all live in the root .env; in Kubernetes each service's secret holds
 * only its own.
 */
export function databaseEnv<const S extends string>(service: S) {
  return forService(service, {
    /** Pooled connection (PgBouncer in Kubernetes) used for all queries. */
    DATABASE_URL: postgresUrl,
    /** Connections this process may hold; the sum across replicas must stay under the server limit. */
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  });
}

/**
 * A direct (non-pooled) connection for LISTEN/NOTIFY, which a transaction-mode pooler
 * silently drops. Only the worker's outbox relay needs it.
 */
export function directDatabaseEnv<const S extends string>(service: S) {
  return forService(service, { DATABASE_DIRECT_URL: postgresUrl });
}

/** The variables, each named with the service in front (`API_` and `DATABASE_URL`). */
function forService<const S extends string, V extends Record<string, z.ZodType>>(
  service: S,
  variables: V,
) {
  // TypeScript can't type a key built from a generic string, so this says what it is.
  // type-coverage:ignore-next-line
  return Object.fromEntries(
    Object.entries(variables).map(([name, schema]) => [`${service}_${name}`, schema]),
  ) as { [K in keyof V & string as `${S}_${K}`]: V[K] };
}

export const redisEnv = {
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
};

/**
 * Makes a variable mandatory in production while allowing a local default elsewhere,
 * so a forgotten production setting fails at boot instead of silently pointing at
 * localhost.
 */
export function requiredInProduction(schema: z.ZodType<string, string>, devDefault: string) {
  return process.env.NODE_ENV === "production" ? schema : schema.default(devDefault);
}

/**
 * Object storage (S3 API). Files are on when S3_BUCKET is set; the rest describe where.
 * RustFS locally (`docker compose --profile files`) and in every cluster (the data chart).
 * Another S3-compatible provider: its S3 endpoint and keys.
 */
export const storageEnv = {
  S3_BUCKET: z.string().min(3).optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** RustFS/MinIO-style servers without virtual-hosted buckets. */
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
};
