/**
 * Generates the AI service's client from its OpenAPI document (apps/ai/openapi.json,
 * itself generated from the Pydantic models): typed functions per operation, and zod
 * schemas that validate every response at runtime, so a change on the Python side
 * that breaks the contract fails loudly here instead of flowing on as bad data.
 */
import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../../apps/ai/openapi.json",
  output: "src/generated",
  plugins: ["@hey-api/client-fetch", "zod", { name: "@hey-api/sdk", validator: true }],
});
