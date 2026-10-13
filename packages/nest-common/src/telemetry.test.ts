/**
 * startTelemetry's own decisions, in process with the SDK replaced: whether it starts,
 * what it instruments and ignores, and that it flushes on the way out. That spans really
 * reach a collector from a running service is test/telemetry.integration.test.ts.
 */
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  options: undefined as undefined | Record<string, unknown>,
  start: vi.fn(),
  shutdown: vi.fn(async () => undefined),
}));
const register = vi.hoisted(() => vi.fn());

vi.mock("node:module", () => ({ register }));
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    constructor(options: Record<string, unknown>) {
      sdk.options = options;
    }
    start = sdk.start;
    shutdown = sdk.shutdown;
  },
}));

const { startTelemetry } = await import("./telemetry");

type Http = {
  getConfig(): {
    ignoreIncomingRequestHook(request: IncomingMessage): boolean;
    requestHook(span: unknown): void;
  };
};
/** What startTelemetry passed to the SDK; fails the test if it made none. */
const options = () => {
  if (!sdk.options) {
    throw new Error("startTelemetry created no SDK");
  }
  return sdk.options;
};

describe("startTelemetry", () => {
  beforeEach(() => {
    vi.stubEnv("OTEL_SERVICE_NAME", undefined as unknown as string);
    sdk.options = undefined;
    sdk.start.mockClear();
    sdk.shutdown.mockClear();
    register.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const event of ["SIGTERM", "SIGINT", "beforeExit"] as const) {
      process.removeAllListeners(event);
    }
  });

  it("does nothing without an OTLP endpoint", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    expect(await startTelemetry("api")).toBe(false);
    expect(register).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
  });

  it("starts the SDK with the loader hook, the service's name and every instrumentation", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
    expect(await startTelemetry("api")).toBe(true);
    expect(register).toHaveBeenCalledWith(
      "@opentelemetry/instrumentation/hook.mjs",
      expect.any(String),
    );
    expect(process.env.OTEL_SERVICE_NAME).toBe("api");
    expect(sdk.start).toHaveBeenCalledOnce();
    const names = (options().instrumentations as { instrumentationName: string }[]).map(
      (instrumentation) => instrumentation.instrumentationName,
    );
    expect(names).toEqual([
      "@opentelemetry/instrumentation-http",
      "@opentelemetry/instrumentation-pg",
      "@opentelemetry/instrumentation-ioredis",
      "@opentelemetry/instrumentation-pino",
    ]);
    expect(options().traceExporter?.constructor.name).toBe("OTLPTraceExporter");
    expect(options().metricReaders).toHaveLength(1);
  });

  it("keeps a service name set in the environment", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
    vi.stubEnv("OTEL_SERVICE_NAME", "api-canary");
    await startTelemetry("api");
    expect(process.env.OTEL_SERVICE_NAME).toBe("api-canary");
  });

  it("leaves health probes out of the traces", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
    await startTelemetry("api");
    const [http] = options().instrumentations as Http[];
    const ignored = (url?: string) =>
      http?.getConfig().ignoreIncomingRequestHook({ url } as IncomingMessage);
    expect(ignored("/health/live")).toBe(true);
    expect(ignored("/health/ready")).toBe(true);
    expect(ignored("/rpc/todos.list")).toBe(false);
    expect(ignored(undefined)).toBe(false);
  });

  it("strips query values from the URLs on HTTP spans", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
    await startTelemetry("api");
    const [http] = options().instrumentations as Http[];
    const attributes: Record<string, unknown> = { "url.full": "https://x.dev/cb?code=secret" };
    http?.getConfig().requestHook({
      attributes,
      setAttribute: (key: string, value: string) => {
        attributes[key] = value;
      },
    });
    expect(attributes["url.full"]).toBe("https://x.dev/cb?code=");
  });

  it("flushes on SIGTERM, SIGINT and a natural exit", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
    await startTelemetry("api");
    for (const event of ["SIGTERM", "SIGINT", "beforeExit"] as const) {
      const [listener] = process.listeners(event) as (() => void)[];
      listener?.();
    }
    expect(sdk.shutdown).toHaveBeenCalledTimes(3);
  });
});
