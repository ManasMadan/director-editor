// What a service's dist/telemetry.mjs does, loaded with `node --import` like in production.
import { startTelemetry } from "../../src/telemetry.ts";

await startTelemetry("telemetry-test");
