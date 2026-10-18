/**
 * Director's shared demo account: `bun run --filter @repo/api director:demo-account` makes
 * it (verified, flagged, with the seeded templates) and running it again keeps what the
 * judges did with it; `system.info` shows its credentials for the sign-in page; and the
 * account can't be changed or locked by whoever signs in to it.
 */
import { directorSeeds } from "@repo/contracts/director-seeds";
import { userIdSchema } from "@repo/contracts/ids";
import { factories } from "@repo/db/testing";
import { DATABASE, type Database } from "@repo/nest-common";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  command,
  createSession,
  type Harness,
  newEmail,
  newPassword,
  refusingExit,
  startApi,
  takeOtp,
} from "./harness";

const DEMO = { email: "demo@director.mmadan.in", password: "demo-password-for-the-tests" };
const ENTRY = "../src/director-demo-account";
const SEED_IDS = directorSeeds.map((seed) => seed.videoId).sort();

let harness: Harness;
let database: Database;
/** The AI service's connection, under row-level security, to read the library's plans. */
let aiDb: pg.Pool;

beforeAll(async () => {
  harness = await startApi(3, { DEMO_PASSWORD: DEMO.password });
  database = harness.app.get<Database>(DATABASE);
  aiDb = new pg.Pool({ connectionString: harness.testDb.urlFor("app_ai") });
});
afterAll(async () => {
  await aiDb?.end();
  await harness?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The demo account's row, and its personal workspace's id. */
async function demoAccount() {
  const user = await database.write.user.findUniqueOrThrow({
    where: { email: DEMO.email },
    select: { id: true, emailVerified: true, demo: true },
  });
  const workspace = await database.write.organization.findUniqueOrThrow({
    where: { slug: `personal-${user.id}` },
    select: { id: true },
  });
  return { ...user, orgId: workspace.id };
}

/** Runs `sql` as the AI service does, in one workspace. */
async function asAi<T extends pg.QueryResultRow>(
  orgId: string,
  sql: string,
  values: unknown[] = [],
) {
  const client = await aiDb.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const { rows } = await client.query<T>(sql, values);
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `sql` as the database's superuser: for what no service may do (losing a seed). */
async function asSuperuser(sql: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
  await client.connect();
  try {
    await client.query(sql, values);
  } finally {
    await client.end();
  }
}

/**
 * The workspace's plans, which Short and whether it's a seed or someone's own, in the
 * order SEED_IDS is in (sorted here, not by Postgres's collation).
 */
async function plans(orgId: string) {
  const rows = await asAi<{ videoId: string; source: string }>(
    orgId,
    'SELECT video_id AS "videoId", source FROM ai.director_plan',
  );
  return rows.sort((a, b) => (a.videoId < b.videoId ? -1 : 1));
}

/** Signs in as the demo account with the password the API has. */
async function signedInAsDemo() {
  const session = createSession(harness);
  const signIn = await session.auth("/sign-in/email", DEMO);
  expect(signIn.status).toBe(200);
  return session;
}

describe("the demo account command", () => {
  it("refuses outside production without --force, and says how to run it", async () => {
    const exit = refusingExit();
    const run = await command(ENTRY);
    expect(exit).toHaveBeenCalledWith(1);
    expect(run.errors).toEqual([
      "The demo account is for production; pass --force to make it in this environment.",
    ]);
    expect(await database.write.user.count({ where: { email: DEMO.email } })).toBe(0);
  });

  it("refuses without DEMO_PASSWORD, and an option it doesn't know", async () => {
    const exit = refusingExit();
    const unset = await command(ENTRY, { DEMO_PASSWORD: "" }, ["--force"]);
    expect(unset.errors).toEqual([
      "DEMO_PASSWORD isn't set: set it to the password the demo account should have.",
    ]);
    const typo = await command(ENTRY, {}, ["--force", "--rest"]);
    expect(typo.errors).toEqual(["Unknown option --rest. Options: --force, --reset."]);
    expect(exit).toHaveBeenCalledTimes(2);
  });

  it("creates the account: verified, flagged, the seeds in its library, signing in with DEMO_PASSWORD", async () => {
    const run = await command(ENTRY, {}, ["--force"]);
    expect(run.lines).toEqual([`Created the demo account ${DEMO.email}.`]);

    const account = await demoAccount();
    expect(account).toMatchObject({ emailVerified: true, demo: true });
    expect((await plans(account.orgId)).map((plan) => plan.videoId)).toEqual(SEED_IDS);

    const session = await signedInAsDemo();
    expect(await session.rpc.user.me()).toMatchObject({
      email: DEMO.email,
      activeOrganizationId: account.orgId,
    });
    const current = await session.authGet<{ user: { demo: boolean } }>("/get-session");
    expect(current.user.demo).toBe(true);
  });

  it("run again, keeps the account and what was done with it, and puts back the password and any missing seed", async () => {
    const before = await demoAccount();
    // What a judge leaves behind: their own Short. And a seed gone missing.
    const [ownShort, missingSeed = ""] = ["own-short-1", SEED_IDS[0]];
    await asAi(
      before.orgId,
      "INSERT INTO ai.director_plan (org_id, created_by, video_id, source, updated_at) VALUES ($1, $2, $3, 'user', now())",
      [before.orgId, before.id, ownShort],
    );
    await asSuperuser("DELETE FROM ai.director_plan WHERE org_id = $1 AND video_id = $2", [
      before.orgId,
      missingSeed,
    ]);

    const run = await command(ENTRY, { DEMO_PASSWORD: "a-rotated-demo-password" }, ["--force"]);
    expect(run.lines).toEqual([
      `Updated the demo account ${DEMO.email}: copied 1 missing seeded templates, and kept its own Shorts and takes.`,
    ]);
    const after = await demoAccount();
    expect(after.id).toBe(before.id);
    const library = await plans(after.orgId);
    expect(library).toContainEqual({ videoId: ownShort, source: "user" });
    expect(library.filter((plan) => plan.source === "seed").map((p) => p.videoId)).toEqual(
      SEED_IDS,
    );
    const session = createSession(harness);
    expect(
      (await session.auth("/sign-in/email", { ...DEMO, password: "a-rotated-demo-password" }))
        .status,
    ).toBe(200);
  });

  it("with --reset starts over: a new account, only the seeds, the old one's sessions gone", async () => {
    // Back to the password the API shows.
    await command(ENTRY, {}, ["--force"]);
    const before = await demoAccount();
    const judge = await signedInAsDemo();

    const run = await command(ENTRY, {}, ["--force", "--reset"]);
    expect(run.lines).toEqual([
      `Reset the demo account ${DEMO.email}: deleted it with its workspaces (its own Shorts, takes and cuts), then made it again.`,
    ]);
    const after = await demoAccount();
    expect(after.id).not.toBe(before.id);
    expect(after).toMatchObject({ emailVerified: true, demo: true });
    expect((await plans(after.orgId)).map((plan) => plan.source)).toEqual(
      SEED_IDS.map(() => "seed"),
    );
    expect(await database.write.organization.count({ where: { id: before.orgId } })).toBe(0);
    await expect(judge.rpc.user.me()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("flags an account that wasn't, its sessions from before included", async () => {
    const { id } = await demoAccount();
    await database.write.user.update({ where: { id }, data: { demo: false } });
    const session = await signedInAsDemo();
    const before = await session.authGet<{ user: { demo: boolean } }>("/get-session");
    expect(before.user.demo).toBe(false);

    await command(ENTRY, {}, ["--force"]);
    expect((await demoAccount()).demo).toBe(true);
    const after = await session.authGet<{ user: { demo: boolean } }>("/get-session");
    expect(after.user.demo).toBe(true);
    expect((await session.auth("/revoke-other-sessions")).status).toBe(403);
  });

  it("run again, puts back the account's and its workspace's names", async () => {
    const { id, orgId } = await demoAccount();
    await database.write.user.update({ where: { id }, data: { name: "Defaced" } });
    await database.write.organization.update({ where: { id: orgId }, data: { name: "Defaced" } });
    await command(ENTRY, {}, ["--force"]);
    expect(
      await database.write.user.findUniqueOrThrow({ where: { id }, select: { name: true } }),
    ).toEqual({ name: "Director Demo" });
    expect(
      await database.write.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { name: true },
      }),
    ).toEqual({ name: "Director Demo" });
  });

  it("with --reset leaves a workspace it shares with someone else", async () => {
    const { id } = await demoAccount();
    const someone = await factories(database.write).userWithWorkspace();
    await factories(database.write).member(someone.org.id, userIdSchema.parse(id));
    await command(ENTRY, {}, ["--force", "--reset"]);
    expect(await database.write.organization.count({ where: { id: someone.org.id } })).toBe(1);
    expect(await database.write.member.count({ where: { organizationId: someone.org.id } })).toBe(
      1,
    );
  });

  it("gives back a password sign-in to a demo account that lost it", async () => {
    const { id } = await demoAccount();
    await database.write.account.deleteMany({ where: { userId: id, providerId: "credential" } });
    await command(ENTRY, {}, ["--force"]);
    await signedInAsDemo();
  });

  it("says what to do when the demo account has no workspace of its own", async () => {
    const { orgId } = await demoAccount();
    await database.write.organization.delete({ where: { id: orgId } });
    const run = await command(ENTRY, {}, ["--force"]);
    expect(String(run.thrown)).toContain("has no personal workspace: run it with --reset");
    await command(ENTRY, {}, ["--force", "--reset"]);
    expect((await plans((await demoAccount()).orgId)).length).toBe(SEED_IDS.length);
  });
});

describe("the demo account's credentials", () => {
  it("are in system.info for the sign-in page, since DEMO_PASSWORD is set", async () => {
    const info = await createSession(harness).rpc.system.info();
    expect(info.demo).toEqual(DEMO);
  });
});

describe("signing in to the demo account", () => {
  it("has no per-account attempt limit: its password is public, and everyone shares it", async () => {
    // Anyone else's account allows 10 attempts in 15 minutes (account-limits.ts).
    for (let attempt = 0; attempt < 12; attempt++) {
      await signedInAsDemo();
    }
  });
});

describe("what the demo account can't do", () => {
  const bodies: [string, (organizationId: string) => object][] = [
    ["/change-password", () => ({ currentPassword: DEMO.password, newPassword: newPassword() })],
    ["/delete-user", () => ({ password: DEMO.password })],
    ["/two-factor/enable", () => ({ password: DEMO.password })],
    ["/link-social", () => ({ provider: "google", callbackURL: process.env.WEB_URL })],
    ["/revoke-session", () => ({ token: "another-judges-session" })],
    ["/revoke-other-sessions", () => ({})],
    ["/revoke-sessions", () => ({})],
    ["/organization/delete", (organizationId) => ({ organizationId })],
    ["/organization/update", (organizationId) => ({ organizationId, data: { name: "Defaced" } })],
    ["/organization/leave", (organizationId) => ({ organizationId })],
    ["/organization/create", () => ({ name: "Another", slug: `another-${newPassword()}` })],
  ];
  it.each(bodies)("%s answers DEMO_ACCOUNT_LOCKED", async (path, body) => {
    const before = await demoAccount();
    const session = await signedInAsDemo();
    const answer = await session.auth<{ code: string }>(path, body(before.orgId));
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe("DEMO_ACCOUNT_LOCKED");
    // Still the same account and workspace, still signed in.
    await signedInAsDemo();
    expect(await session.rpc.user.me()).toMatchObject({
      email: DEMO.email,
      activeOrganizationId: before.orgId,
    });
    expect(
      await database.write.organization.findUniqueOrThrow({
        where: { id: before.orgId },
        select: { name: true },
      }),
    ).toEqual({ name: "Director Demo" });
    expect(await database.write.member.count({ where: { userId: before.id } })).toBe(1);
  });

  it("can't rename itself or change its picture, but keeps its own time zone", async () => {
    const session = await signedInAsDemo();
    const renamed = await session.auth<{ code: string }>("/update-user", { name: "Defaced" });
    expect(renamed.status).toBe(403);
    expect(renamed.body.code).toBe("DEMO_ACCOUNT_LOCKED");
    await expect(session.rpc.user.setAvatar({ fileId: null })).rejects.toMatchObject({
      code: "DEMO_ACCOUNT_LOCKED",
    });
    expect(
      (await session.auth("/update-user", { timezone: "Asia/Tokyo", locale: "en" })).status,
    ).toBe(200);
    expect(await session.rpc.user.me()).toMatchObject({
      name: "Director Demo",
      timezone: "Asia/Tokyo",
    });
  });

  it("sees only its own device: never the other people signed in to it", async () => {
    const elsewhere = await signedInAsDemo();
    const session = await signedInAsDemo();
    const current = await session.authGet<{ session: { id: string } }>("/get-session");
    const listed = await session.authGet<{ id: string }[]>("/list-sessions");
    expect(listed.map((row) => row.id)).toEqual([current.session.id]);
    const theirs = await elsewhere.authGet<{ session: { id: string } }>("/get-session");
    expect(theirs.session.id).not.toBe(current.session.id);
  });

  it("is never something sign-up or a profile edit can claim", async () => {
    const email = newEmail();
    const session = createSession(harness);
    await session.auth("/sign-up/email", { email, password: newPassword(), name: "Not demo" });
    const { otp } = await takeOtp(harness, email);
    await session.auth("/email-otp/verify-email", { email, otp });
    const claimed = await session.auth("/sign-up/email", {
      email: newEmail(),
      password: newPassword(),
      name: "Claims demo",
      demo: true,
    });
    expect(claimed.status).toBe(400);
    const edit = await session.auth("/update-user", { demo: true });
    expect(edit.status).toBe(400);
    expect(
      await database.write.user.findUniqueOrThrow({ where: { email }, select: { demo: true } }),
    ).toEqual({ demo: false });
    // Anyone else changes their own account as before.
    const changed = await session.auth("/update-user", { name: "Renamed" });
    expect(changed.status).toBe(200);
  });
});
