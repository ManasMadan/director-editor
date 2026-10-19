/**
 * The database's CHECK lists for enum-like text columns name the same values as the
 * contracts' zod enums, which the services parse rows with. Otherwise a value one side
 * allows fails on the other: an insert the contract accepts is refused, or a row the
 * database holds can't be read back.
 */
import {
  assetImageSchema,
  directorCutSchema,
  directorPlanSchema,
  directorTakeSchema,
  fileSchema,
  recordingAttemptSchema,
  recordingPartSchema,
  recordingSessionSchema,
} from "@repo/contracts/api";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing";

const expected: Record<string, readonly string[]> = {
  "files.file.file_status_check": fileSchema.shape.status.options,
  "ai.director_plan.director_plan_status_check": directorPlanSchema.shape.status.options,
  "ai.director_plan.director_plan_source_check": directorPlanSchema.shape.source.options,
  "ai.director_plan.director_plan_stage_check": directorPlanSchema.shape.stage.options,
  "ai.director_plan.director_plan_audio_status_check":
    directorPlanSchema.shape.audio.shape.status.options,
  "ai.director_cut.director_cut_publish_status_check":
    directorCutSchema.shape.publish.shape.status.options,
  "ai.director_cut.director_cut_visibility_check":
    directorCutSchema.shape.publish.shape.visibility.unwrap().options,
  "ai.director_take.director_take_status_check": directorTakeSchema.shape.status.options,
  "ai.director_take.director_take_kind_check": directorTakeSchema.shape.kind.options,
  // An asset image's stored status: the AI service's AssetImageStatus and the API's wire
  // schema of it (director.service.ts); the contract serves them folded into
  // making/ready/failed, so there's no contract enum of these four to read.
  "ai.director_asset.director_asset_status_check": ["pending", "generating", "ready", "failed"],
  // The member's own images, plus two the AI service stores in the same table but never
  // serves among them (its AssetOrigin): a slot's default image, and a created plan's
  // storyboard cards, which belong to no slot.
  "ai.director_asset.director_asset_origin_check": [
    "default",
    "storyboard",
    ...assetImageSchema.shape.origin.options,
  ],
  "app.recording_session.recording_session_status_check":
    recordingSessionSchema.shape.status.options,
  "app.recording_part.recording_part_camera_check": recordingPartSchema.shape.camera.options,
  "app.recording_part.recording_part_content_type_check":
    recordingPartSchema.shape.contentType.options,
  "app.recording_attempt.recording_attempt_status_check":
    recordingAttemptSchema.shape.status.options,
  // A slice is served as the indexes of those uploaded (RecordingPart's `uploaded`), so
  // there's no contract enum of its two states.
  "app.recording_slice.recording_slice_status_check": ["pending", "uploaded"],
  // The removed Shorts feed's likes and saves: no service reads the table any more, and
  // it goes in a later release's migration; until then its CHECK stays as it was.
  "app.short_reaction.short_reaction_kind_check": ["like", "save"],
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
