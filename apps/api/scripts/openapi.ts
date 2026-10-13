/**
 * Writes the public API's OpenAPI document to the given file (`bun run gen`). The
 * committed copy describes version 1 of the API relative to its path; the server serves
 * the same document with the release and its public URL filled in.
 */
import { writeFileSync } from "node:fs";
import { openApiDocument } from "../src/rpc/openapi";

export async function writeOpenApi(file: string | undefined) {
  if (!file) {
    throw new Error("usage: bun scripts/openapi.ts <file>");
  }
  const spec = await openApiDocument({ version: "1", serverUrl: "/api/v1" });
  writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
}

// Run as `bun scripts/openapi.ts <file>`, not when a test imports it.
import.meta.main && (await writeOpenApi(process.argv[2]));
