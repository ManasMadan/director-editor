/**
 * The database's CHECK lists for enum-like text columns name the same values as the
 * contracts' zod enums, which the services parse rows with. Otherwise a value one side
 * allows fails on the other: an insert the contract accepts is refused, or a row the
 * database holds can't be read back.
 */
import {
  aiDocumentSchema,
  directorPlanSchema,
  directorTakeSchema,
  fileSchema,
  shortReactionKinds,
} from "@repo/contracts/api";
import { pushPlatforms } from "@repo/contracts/notifications";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing";

const expected: Record<string, readonly string[]> = {
  "notifications.device.device_platform_check": pushPlatforms,
  "files.file.file_status_check": fileSchema.shape.status.options,
  "ai.document.document_status_check": aiDocumentSchema.shape.status.options,
  "ai.director_plan.director_plan_status_check": directorPlanSchema.shape.status.options,
  "ai.director_take.director_take_status_check": directorTakeSchema.shape.status.options,
  "ai.director_take.director_take_kind_check": directorTakeSchema.shape.kind.options,
  "app.short_reaction.short_reaction_kind_check": shortReactionKinds,
};

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

it("lists the contracts' values in every enum-like CHECK", async () => {
  const client = new pg.Client({ connectionString: testDb.urlFor("migrator") });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string; definition: string }>(`
      SELECT conrelid::regclass::text || '.' || conname AS name,
             pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE contype = 'c' AND pg_get_constraintdef(oid) LIKE '%ANY (ARRAY[%'`);
    const actual = Object.fromEntries(
      rows.map(({ name, definition }) => [
        name,
        [...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1]).sort(),
      ]),
    );
    const contracts = Object.fromEntries(
      Object.entries(expected).map(([name, values]) => [name, [...values].sort()]),
    );
    // A new enum-like CHECK needs its contract enum added above.
    expect(actual).toEqual(contracts);
  } finally {
    await client.end();
  }
});
