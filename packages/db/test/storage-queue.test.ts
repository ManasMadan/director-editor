/**
 * Objects in storage outlive no row: however a Director asset's row goes (its plan, its
 * workspace or its member deleted, a demo purge), the images under director-assets/ it
 * named are queued in files.object_deletion for the worker's files cleanup. An upload's
 * object (files/<id>) goes with its files.file row instead, by that table's trigger.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb?.drop();
});

/** Runs `fn` as the database's superuser: fixtures past row-level security. */
async function superuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDb.urlFor("postgres") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe("a Director asset's objects", () => {
  it("are queued for deletion when its row goes, whichever way, uploads left to their file", async () => {
    const org = randomUUID();
    const upload = randomUUID();
    const queued = await superuser(async (client) => {
      await client.query(
        "INSERT INTO auth.organization (id, name, slug) VALUES ($1::uuid, 'Org', $1::text)",
        [org],
      );
      const {
        rows: [plan],
      } = await client.query<{ id: string }>(
        `INSERT INTO ai.director_plan (org_id, video_id, source, updated_at)
         VALUES ($1, 'AssetsGone1', 'seed', now()) RETURNING id`,
        [org],
      );
      const planId = plan?.id;
      const asset = (origin: string, objectKey: string | null, referenceKey: string | null) =>
        client.query(
          `INSERT INTO ai.director_asset (org_id, plan_id, asset_id, origin, object_key, reference_key, updated_at)
           VALUES ($1, $2, 'mug', $3, $4, $5, now())`,
          [org, planId, origin, objectKey, referenceKey],
        );
      await asset("default", `director-assets/${planId}/mug.png`, null);
      await asset("created", `director-assets/${planId}/mug/drawn.png`, `files/${upload}`);
      await asset("created", null, `director-assets/${planId}/mug/base.png`);
      await asset("upload", `files/${upload}`, null);
      await asset("stock", `director-assets/${planId}/mug/stock.jpg`, null);
      // A pending one has no object yet: nothing to queue.
      await asset("created", null, null);
      // The workspace goes, its plans and their assets with it.
      await client.query("DELETE FROM auth.organization WHERE id = $1", [org]);
      const { rows } = await client.query<{ key: string }>(
        "SELECT key FROM files.object_deletion WHERE key LIKE $1 OR key = $2",
        [`director-assets/${planId}/%`, `files/${upload}`],
      );
      return { keys: rows.map((row) => row.key).sort(), planId };
    });
    expect(queued.keys).toEqual(
      [
        `director-assets/${queued.planId}/mug.png`,
        `director-assets/${queued.planId}/mug/base.png`,
        `director-assets/${queued.planId}/mug/drawn.png`,
        `director-assets/${queued.planId}/mug/stock.jpg`,
      ].sort(),
    );
  });

  it("leave no joined copy of a recording's parts behind once its session goes", async () => {
    const [org, user] = [randomUUID(), randomUUID()];
    const queued = await superuser(async (client) => {
      await client.query(
        "INSERT INTO auth.organization (id, name, slug) VALUES ($1::uuid, 'Org', $1::text)",
        [org],
      );
      await client.query(
        `INSERT INTO auth."user" (id, name, email, updated_at) VALUES ($1::uuid, 'U', $1::text || '@test.dev', now())`,
        [user],
      );
      const {
        rows: [plan],
      } = await client.query<{ id: string }>(
        `INSERT INTO ai.director_plan (org_id, video_id, source, updated_at)
         VALUES ($1, 'Recorded001', 'seed', now()) RETURNING id`,
        [org],
      );
      const {
        rows: [session],
      } = await client.query<{ id: string }>(
        `INSERT INTO app.recording_session (org_id, user_id, plan_id, video_id, shot_count, expires_at, updated_at)
         VALUES ($1, $2, $3, 'Recorded001', 2, now(), now()) RETURNING id`,
        [org, user, plan?.id],
      );
      await client.query(
        `INSERT INTO app.recording_part (session_id, org_id, index, camera, content_type)
         VALUES ($1, $2, 0, 'front', 'video/webm'), ($1, $2, 1, 'back', 'video/webm')`,
        [session?.id, org],
      );
      await client.query("DELETE FROM app.recording_session WHERE id = $1", [session?.id]);
      const { rows } = await client.query<{ key: string }>(
        "SELECT key FROM files.object_deletion WHERE key LIKE $1",
        [`recordings/${session?.id}/%`],
      );
      return { keys: rows.map((row) => row.key).sort(), session: session?.id };
    });
    expect(queued.keys).toEqual([
      `recordings/${queued.session}/0/whole`,
      `recordings/${queued.session}/1/whole`,
    ]);
  });

  it("are queued once, however many times the same key is", async () => {
    const org = randomUUID();
    await superuser(async (client) => {
      await client.query(
        "INSERT INTO auth.organization (id, name, slug) VALUES ($1::uuid, 'Org', $1::text)",
        [org],
      );
      const {
        rows: [plan],
      } = await client.query<{ id: string }>(
        `INSERT INTO ai.director_plan (org_id, video_id, source, updated_at)
         VALUES ($1, 'AssetsGone2', 'seed', now()) RETURNING id`,
        [org],
      );
      const key = `director-assets/${plan?.id}/mug.png`;
      await client.query("INSERT INTO files.object_deletion (key) VALUES ($1)", [key]);
      await client.query(
        `INSERT INTO ai.director_asset (org_id, plan_id, asset_id, origin, object_key, updated_at)
         VALUES ($1, $2, 'mug', 'default', $3, now())`,
        [org, plan?.id, key],
      );
      await expect(
        client.query("DELETE FROM ai.director_plan WHERE id = $1", [plan?.id]),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
  });
});
