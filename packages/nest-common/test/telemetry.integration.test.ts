/**
 * Telemetry, the way services run it (`node --import dist/telemetry.mjs dist/main.mjs`):
 * with an OTLP endpoint, traces from HTTP, Postgres and Redis reach the collector and
 * log lines carry the trace; without one, nothing is sent.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { redisDatabase } from "../src/testing";

interface Received {
  path: string;
  body: string;
}
let collector: Server;
let endpoint: string;
let received: Received[] = [];

beforeAll(async () => {
  collector = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({ path: request.url ?? "", body });
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => collector.close(resolve)));
beforeEach(() => {
  received = [];
});

const fixtures = join(import.meta.dirname, "fixtures");
/** Runs the stand-in service to completion (asynchronously: the collector answers it). */
async function runService(env: Record<string, string>) {
  const { OTEL_EXPORTER_OTLP_ENDPOINT: _inherited, ...rest } = process.env;
  const child = spawn(
    process.execPath,
    ["--import", join(fixtures, "telemetry-start.mjs"), join(fixtures, "telemetry-app.mjs")],
    { env: { ...rest, TELEMETRY_TEST_REDIS_URL: redisDatabase(12), ...env } },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect(code, stderr).toBe(0);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { msg?: string; trace_id?: string });
}

interface ExportedSpans {
  resourceSpans: {
    resource: { attributes: { key: string; value: { stringValue?: string } }[] };
    scopeSpans: { scope: { name: string }; spans: { traceId: string }[] }[];
  }[];
}

describe("telemetry", () => {
  it("exports traces from HTTP, Postgres and Redis, and puts the trace on log lines", async () => {
    const logs = await runService({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });

    const traces = received
      .filter((request) => request.path === "/v1/traces")
      .map((request) => JSON.parse(request.body) as ExportedSpans);
    expect(traces.length).toBeGreaterThan(0);
    const resourceSpans = traces.flatMap((trace) => trace.resourceSpans);
    const serviceNames = resourceSpans.flatMap((spans) =>
      spans.resource.attributes.filter((attribute) => attribute.key === "service.name"),
    );
    expect(serviceNames.map((attribute) => attribute.value.stringValue)).toContain(
      "telemetry-test",
    );
    const scopes = resourceSpans.flatMap((spans) => spans.scopeSpans);
    expect(scopes.map((scope) => scope.scope.name)).toEqual(
      expect.arrayContaining([
        "@opentelemetry/instrumentation-http",
        "@opentelemetry/instrumentation-pg",
        "@opentelemetry/instrumentation-ioredis",
      ]),
    );

    // The request's log line carries the trace the collector received.
    const line = logs.find((entry) => entry.msg === "handling a request");
    const traceIds = scopes.flatMap((scope) => scope.spans.map((span) => span.traceId));
    expect(line?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIds).toContain(line?.trace_id);
    // URLs keep their query's names, never its values (in and out).
    const exported = JSON.stringify(traces);
    expect(exported).toContain("code=&state=");
    expect(exported).not.toContain("secret-code");
    // Metrics go to the same collector.
    expect(received.some((request) => request.path === "/v1/metrics")).toBe(true);
  });

  it("sends nothing and changes nothing without an endpoint", async () => {
    const logs = await runService({});
    expect(received).toEqual([]);
    expect(logs.find((entry) => entry.msg === "handling a request")?.trace_id).toBeUndefined();
  });
});
