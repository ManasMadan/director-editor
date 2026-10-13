// Loaded before the service (`node --import ./dist/telemetry.mjs dist/main.mjs`), so what
// it instruments is wrapped as it loads; off without OTEL_EXPORTER_OTLP_ENDPOINT
// (packages/nest-common/src/telemetry.ts).
import { startTelemetry } from "@repo/nest-common/telemetry";

await startTelemetry("notifications");
