/**
 * Director's seeded templates: every workspace starts with the 6 in its library, copied in
 * as it's created, and the backfill gives them to workspaces made before. The library is
 * read through the API from a stand-in for the AI service that answers from the database
 * as apps/ai does (as app_ai, under row-level security, with ai.index_used), so what the
 * API wrote is what a member sees. The AI service's own handling of seeds (indexing one
 * returns it and counts for no one) is covered by apps/ai/tests/test_director.py.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { directorSeeds } from "@repo/contracts/director-seeds";
import { type OrgId, orgIdSchema } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { type Database, transaction } from "@repo/db";
import { factories } from "@repo/db/testing";
import { DATABASE } from "@repo/nest-common";
import { jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copySeedTemplates, seedWorkspaces } from "../src/modules/director/seeds.repository";
import {
  createSession,
  type Harness,
  LOCAL_STORAGE,
  newEmail,
  newPassword,
  startApi,
  takeOtp,
} from "./harness";

const SECRET = `test-ai-secret-${randomUUID()}`;
const SEED_IDS = directorSeeds.map((seed) => seed.videoId);
const [FIRST_SEED = ""] = SEED_IDS;

let harness: Harness;
let database: Database;
let ai: Server;
/** The AI service's connection: its own role, so its grants and row-level security apply. */
let aiDb: pg.Pool;

/** Runs `fn` as the AI service does, scoped to one workspace. */
async function asAi<T>(orgId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await aiDb.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface PlanRow {
  id: string;
  videoId: string;
  source: string;
  status: string;
  createdBy: string | null;
}

const plansOf = (orgId: string) =>
  asAi(orgId, async (client) => {
    const { rows } = await client.query<PlanRow>(
      `SELECT id, video_id AS "videoId", source, status, created_by AS "createdBy"
         FROM ai.director_plan ORDER BY id DESC`,
    );
    return rows;
  });

const indexUsed = async (orgId: string, userId: string) =>
  asAi(orgId, async (client) => {
    const { rows } = await client.query<{ used: boolean }>("SELECT ai.index_used($1) AS used", [
      userId,
    ]);
    return rows[0]?.used;
  });

/** apps/ai's library (Director.library): the workspace's plans, newest first. */
async function library(orgId: string, userId: string) {
  const templates = await asAi(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, video_id AS "videoId", source, status, stage, error, plan, model,
              audio_status AS "audioStatus", audio_key AS "audioKey",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM ai.director_plan ORDER BY id DESC`,
    );
    return rows;
  });
  return { templates, indexUsed: await indexUsed(orgId, userId) };
}

async function aiRoute(request: IncomingMessage, response: ServerResponse) {
  const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
  const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
    issuer: "api",
    audience: "ai",
  });
  if (`${request.method} ${request.url}` !== "GET /v1/director/library") {
    response.writeHead(404).end();
    return;
  }
  const body = await library(String(payload.org), String(payload.sub));
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

beforeAll(async () => {
  ai = createServer((request, response) => {
    aiRoute(request, response).catch(() => response.writeHead(401).end());
  });
  await new Promise<void>((resolve) => ai.listen(0, "127.0.0.1", resolve));
  harness = await startApi(26, {
    ...LOCAL_STORAGE,
    AI_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
    AI_SERVICE_SECRET: SECRET,
  });
  database = harness.app.get<Database>(DATABASE);
  aiDb = new pg.Pool({ connectionString: harness.testDb.urlFor("app_ai"), max: 2 });
});

afterAll(async () => {
  await aiDb?.end();
  await harness?.close();
  await new Promise((resolve) => ai?.close(resolve));
});

async function signedUp() {
  const session = createSession(harness);
  const email = newEmail();
  await session.auth("/sign-up/email", { email, password: newPassword(), name: "Director" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  const me = await session.rpc.user.me();
  return { session, userId: me.id, orgId: orgIdSchema.parse(me.activeOrganizationId) };
}

describe("Director's seeded templates", () => {
  it("are in a new member's library from sign-up: all 6, ready to film, no one's index", async () => {
    const { session } = await signedUp();
    const { templates, indexUsed: used } = await session.rpc.director.library();
    // The first seed first, as the seed list orders them.
    expect(templates.map((template) => template.videoId)).toEqual(SEED_IDS);
    for (const [index, template] of templates.entries()) {
      const seed = required(directorSeeds[index], "a seed");
      const { musicKey, shots, ...plan } = seed.plan;
      expect(template).toMatchObject({
        source: "seed",
        status: "ready",
        stage: "ready",
        error: null,
        model: seed.model,
        plan: {
          ...plan,
          shots: shots.map(({ storyboardKey, previewKey, ...shot }) => shot),
        },
        audio: { status: "ready" },
      });
      // Short-lived links to the seed's audio and its media, through the storage seam,
      // where the copy holds only their keys.
      expect(template.audio.url).toContain(`seed-audio/${template.videoId}.m4a`);
      expect(template.plan?.musicUrl).toContain(required(musicKey, "a music key"));
      for (const [shotIndex, shot] of shots.entries()) {
        const served = template.plan?.shots[shotIndex];
        expect(served?.storyboardUrl).toContain(required(shot.storyboardKey, "a storyboard"));
        expect(served?.previewUrl).toContain(required(shot.previewKey, "a preview"));
        expect(served).not.toHaveProperty("storyboardKey");
      }
    }
    expect(used).toBe(false);
  });

  it("are copied once into each workspace: a team gets its own, and again adds nothing", async () => {
    const { session, orgId: personal } = await signedUp();
    const team = await session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    const teamId = orgIdSchema.parse(team.body.id);
    await session.auth("/organization/set-active", { organizationId: teamId });
    const { templates } = await session.rpc.director.library();
    expect(templates.map((template) => template.videoId)).toEqual(SEED_IDS);

    expect(await transaction(database.write, (tx) => copySeedTemplates(tx, teamId))).toBe(0);
    for (const orgId of [personal, teamId]) {
      const plans = await plansOf(orgId);
      expect(plans).toHaveLength(SEED_IDS.length);
      expect(plans.every((plan) => plan.source === "seed" && plan.createdBy === null)).toBe(true);
    }
    // Each workspace's own rows: none shared.
    const ids = [...(await plansOf(personal)), ...(await plansOf(teamId))].map((plan) => plan.id);
    expect(new Set(ids).size).toBe(SEED_IDS.length * 2);
  });

  it("leave a member's one index unused when they index a seeded Short themselves", async () => {
    const { userId, orgId } = await signedUp();
    // What the AI service's index does (Director._claim): the workspace's plan of the
    // video, made in the member's name only if there's none yet.
    const claim = (videoId: string) =>
      asAi(orgId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO ai.director_plan (org_id, created_by, video_id, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (org_id, video_id) DO NOTHING RETURNING id`,
          [orgId, userId, videoId],
        );
        return rows.length;
      });
    expect(await claim(FIRST_SEED)).toBe(0);
    expect(await indexUsed(orgId, userId)).toBe(false);
    const seed = (await plansOf(orgId)).find((plan) => plan.videoId === FIRST_SEED);
    expect(seed).toMatchObject({ source: "seed", status: "ready", createdBy: null });

    // Their one index is still theirs to use, once.
    expect(await claim("OwnShort001")).toBe(1);
    expect(await indexUsed(orgId, userId)).toBe(true);
    await expect(claim("OwnShort002")).rejects.toThrow(/director_plan_one_user_index/);
  });
});

describe("the seed backfill", () => {
  it("copies the seeds into workspaces missing them, never touching members' plans", async () => {
    const make = factories(database.write);
    // Workspaces made before the seeds were copied at creation: one with none, one with a
    // member's own plan of a seeded Short.
    const bare = await make.userWithWorkspace();
    const partial = await make.userWithWorkspace();
    await asAi(partial.org.id, (client) =>
      client.query(
        `INSERT INTO ai.director_plan (org_id, created_by, video_id, updated_at)
         VALUES ($1, $2, $3, now())`,
        [partial.org.id, partial.user.id, FIRST_SEED],
      ),
    );
    const workspaces = await database.read.organization.count();

    expect(await seedWorkspaces(database)).toEqual({
      workspaces,
      seeded: 2,
      templates: SEED_IDS.length * 2 - 1,
    });
    expect((await plansOf(bare.org.id)).map((plan) => plan.videoId).sort()).toEqual(
      [...SEED_IDS].sort(),
    );
    const own = (await plansOf(partial.org.id)).find((plan) => plan.videoId === FIRST_SEED);
    expect(own).toMatchObject({ source: "user", status: "pending", createdBy: partial.user.id });
    expect(await indexUsed(partial.org.id, partial.user.id)).toBe(true);

    // Run again, it changes nothing.
    expect(await seedWorkspaces(database)).toEqual({ workspaces, seeded: 0, templates: 0 });
  });

  it("pages through every workspace", async () => {
    const make = factories(database.write);
    const orgs: OrgId[] = [];
    for (let count = 0; count < 3; count += 1) {
      orgs.push((await make.userWithWorkspace()).org.id);
    }
    const result = await seedWorkspaces(database, 2);
    expect(result).toMatchObject({ seeded: 3, templates: SEED_IDS.length * 3 });
    for (const orgId of orgs) {
      expect(await plansOf(orgId)).toHaveLength(SEED_IDS.length);
    }
  });
});
