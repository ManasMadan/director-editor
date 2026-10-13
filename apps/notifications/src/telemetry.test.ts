/**
 * The service's telemetry bootstrap names it in its traces. What startTelemetry does is
 * packages/nest-common's test; the SDK is replaced the same way here, so nothing exports.
 */
import { afterEach, expect, it, vi } from "vitest";

const start = vi.hoisted(() => vi.fn());
vi.mock("node:module", () => ({ register: vi.fn() }));
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    start = start;
    shutdown = async () => undefined;
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  for (const event of ["SIGTERM", "SIGINT", "beforeExit"] as const) {
    process.removeAllListeners(event);
  }
});

it("starts telemetry as the notifications service when a collector is configured", async () => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
  vi.stubEnv("OTEL_SERVICE_NAME", undefined as unknown as string);
  await import("./telemetry");
  expect(process.env.OTEL_SERVICE_NAME).toBe("notifications");
  expect(start).toHaveBeenCalledOnce();
});
