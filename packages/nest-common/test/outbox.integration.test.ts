/**
 * createOutbox against a real (cloned) database, writing as the api's role: the row an
 * event becomes, and whose organization, actor and request it names.
 */
import { randomUUID } from "node:crypto";
import { createDb, type Db, tenantTx, transaction } from "@repo/db";
import { createTestDatabase, factories, type TestDatabase } from "@repo/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { runWithContext } from "../src/context";
import { createOutbox } from "../src/outbox";

// A catalog of the test's own: plumbing knows no domain events.
const events = { "todo.created.v1": z.object({ todoId: z.uuid(), title: z.string() }) };
const { emitEvent, emitAnyEvent } = createOutbox("app", events);
let testDb: TestDatabase;
let db: Db;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createDb({ url: testDb.urlFor("app_api"), poolMax: 2, service: "test" });
});
afterAll(async () => {
  await db?.$disconnect();
  await testDb?.drop();
});

/** The outbox row for an event key, read as the superuser (across organizations). */
async function row(key: string) {
  const client = new pg.Client({ connectionString: testDb.urlFor("postgres") });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT name, payload, org_id, actor_id, request_id FROM app.outbox_event WHERE key = $1",
      [key],
    );
    return rows[0];
  } finally {
    await client.end();
  }
}

const todo = () => ({ todoId: randomUUID(), title: "Ship it" });

describe("outbox", () => {
  it("names the request's user, organization and id when the event doesn't", async () => {
    const [orgId, userId, key] = [randomUUID(), randomUUID(), randomUUID()];
    await runWithContext({ requestId: "req-1", orgId, userId }, () =>
      transaction(db, (tx) => emitEvent(tx, "todo.created.v1", key, todo())),
    );
    expect(await row(key)).toMatchObject({
      name: "todo.created.v1",
      payload: { title: "Ship it" },
      org_id: orgId,
      actor_id: userId,
      request_id: "req-1",
    });
  });

  it("prefers the tenant the transaction runs as, with no request around", async () => {
    // A real workspace: tenantTx takes only a workspace's id (@repo/db/testing's are).
    const { org } = await factories(db).userWithWorkspace();
    const [orgId, key] = [org.id, randomUUID()];
    await tenantTx(db, orgId, (tx) => emitEvent(tx, "todo.created.v1", key, todo()));
    expect(await row(key)).toMatchObject({ org_id: orgId, actor_id: null, request_id: null });
  });

  it("takes the organization and actor it's given, none included", async () => {
    const [orgId, actorId, key, orphan] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await runWithContext({ requestId: "req-2", orgId: randomUUID(), userId: randomUUID() }, () =>
      transaction(db, async (tx) => {
        await emitEvent(tx, "todo.created.v1", key, todo(), { orgId, actorId });
        await emitEvent(tx, "todo.created.v1", orphan, todo(), { orgId: null, actorId: null });
      }),
    );
    expect(await row(key)).toMatchObject({ org_id: orgId, actor_id: actorId });
    expect(await row(orphan)).toMatchObject({ org_id: null, actor_id: null });
  });

  it("emits an event given as a name and payload together", async () => {
    const key = randomUUID();
    await transaction(db, (tx) =>
      emitAnyEvent(tx, { name: "todo.created.v1", payload: todo() }, key, { orgId: null }),
    );
    expect(await row(key)).toMatchObject({ name: "todo.created.v1" });
  });

  it("refuses an event outside the catalog, or a payload that breaks it", async () => {
    await expect(
      transaction(db, (tx) =>
        emitEvent(tx, "no.such_event.v1" as never, randomUUID(), {} as never),
      ),
    ).rejects.toThrow(/Unknown event "no.such_event.v1"/);
    await expect(
      transaction(db, (tx) =>
        emitEvent(tx, "todo.created.v1", randomUUID(), { title: 1 } as never),
      ),
    ).rejects.toThrow();
  });
});
