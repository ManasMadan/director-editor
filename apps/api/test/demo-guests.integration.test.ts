/**
 * Director's demo guests (src/auth/guest.ts): one tap signs a browser in as a private
 * guest with its own workspace and the seeded templates, for a day, with the demo's
 * restrictions; guests never share anything; and the limits per address and in all hold.
 */
import { directorSeeds } from "@repo/contracts/director-seeds";
import { DAY_S, SECOND_MS } from "@repo/contracts/time";
import { DATABASE, type Database } from "@repo/nest-common";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi, takeOtp } from "./harness";

const DAY_MS = DAY_S * SECOND_MS;
const DEMO_PASSWORD = "demo-password-for-the-guest-tests";
const GUEST_LIMIT = 4;

let harness: Harness;
let database: Database;

beforeAll(async () => {
  harness = await startApi(29, {
    DEMO_GUESTS: "on",
    DEMO_PASSWORD,
    DEMO_GUEST_LIMIT: String(GUEST_LIMIT),
    DEMO_GUESTS_PER_ADDRESS: "2",
  });
  database = harness.app.get<Database>(DATABASE);
});
afterAll(async () => {
  await harness?.close();
});

type Session = ReturnType<typeof createSession>;

/** A new browser trying the demo: signed in as a guest of its own. */
async function guest(session: Session = createSession(harness, { locale: "en" })) {
  const answer = await session.auth<{ created: boolean }>("/sign-in/guest", {
    timezone: "Asia/Kolkata",
  });
  expect(answer).toEqual({ status: 200, body: { created: true } });
  return session;
}

/** Whoever the session is signed in as, as better-auth hands it over. */
const current = (session: Session) =>
  session.authGet<{
    user: { id: string; demo: boolean; guestUntil: string };
    session: { expiresAt: string; activeOrganizationId: string };
  }>("/get-session");

/** How many seeded templates a workspace's library holds, read past row-level security. */
async function seedsIn(orgId: string) {
  const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ai.director_plan WHERE org_id = $1 AND source = 'seed'",
      [orgId],
    );
    return rows[0]?.n;
  } finally {
    await client.end();
  }
}

/** Ends every live guest's day, so a test starts with the cap free. */
const expireGuests = () =>
  database.write.user.updateMany({
    where: { guestUntil: { gt: new Date() } },
    data: { guestUntil: new Date(Date.now() - 1000) },
  });

// Each test makes its own guests, more than GUEST_LIMIT between them: each starts with
// the cap free (the guests stay signed in; only the count frees up).
beforeEach(async () => {
  await expireGuests();
});

describe("trying the demo as a guest", () => {
  it("is on in system.info, with the shared account still there as the fallback", async () => {
    const info = await createSession(harness).rpc.system.info();
    expect(info.features.demoGuests).toBe(true);
    expect(info.demo).toEqual({ email: "demo@director.mmadan.in", password: DEMO_PASSWORD });
  });

  it("signs the browser in as a guest of its own, for a day, with the seeded templates", async () => {
    const started = Date.now();
    const session = await guest();
    const me = await session.rpc.user.me();
    expect(me).toMatchObject({ name: "Guest", timezone: "Asia/Kolkata", locale: "en" });
    expect(me.email).toMatch(/^guest-[0-9a-f-]{36}@guest\.invalid$/);

    const { user, session: signedIn } = await current(session);
    expect(user.demo).toBe(true);
    const until = new Date(user.guestUntil).getTime();
    expect(until).toBeGreaterThanOrEqual(started + DAY_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + DAY_MS);
    // The session ends with the guest, and the browser forgets both cookies then too.
    expect(new Date(signedIn.expiresAt).getTime()).toBe(until);
    expect(signedIn.activeOrganizationId).toBe(me.activeOrganizationId);
    expect(await seedsIn(signedIn.activeOrganizationId)).toBe(directorSeeds.length);
  });

  it("sets both of the session's cookies to last the guest's day, not the browser's", async () => {
    const response = await fetch(`${harness.baseUrl}/api/auth/sign-in/guest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: process.env.WEB_URL ?? "http://localhost:3000",
        "x-forwarded-for": "10.251.0.1",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    for (const name of ["better-auth.session_token", "better-auth.dont_remember"]) {
      const set = cookies.filter((cookie) => cookie.startsWith(`${name}=`)).at(-1);
      expect(set).toMatch(/Max-Age=86400/);
    }
  });

  it("never stretches the guest's session past its day", async () => {
    const session = await guest();
    const before = await current(session);
    // better-auth extends an ordinary session once it's a day old by its expiry; a
    // guest's, ending in a day, would look old enough at once. It stays where it was.
    await session.rpc.user.me();
    const after = await current(session);
    expect(after.session.expiresAt).toBe(before.session.expiresAt);
  });

  it("keeps a guest coming back as the same guest, and a member as themselves", async () => {
    const session = await guest();
    const { user } = await current(session);
    expect(await session.auth("/sign-in/guest", {})).toEqual({
      status: 200,
      body: { created: false },
    });
    expect((await current(session)).user.id).toBe(user.id);

    const member = createSession(harness);
    const email = newEmail();
    await member.auth("/sign-up/email", { email, password: newPassword(), name: "Member" });
    const { otp } = await takeOtp(harness, email);
    await member.auth("/email-otp/verify-email", { email, otp });
    expect(await member.auth("/sign-in/guest", {})).toEqual({
      status: 200,
      body: { created: false },
    });
    expect((await member.rpc.user.me()).email).toBe(email);
  });

  it("gives two browsers two guests that can't reach each other's workspace", async () => {
    const [one, two] = [await guest(), await guest()];
    const [first, second] = [await current(one), await current(two)];
    expect(first.user.id).not.toBe(second.user.id);
    expect(first.session.activeOrganizationId).not.toBe(second.session.activeOrganizationId);
    const intrusion = await two.auth("/organization/set-active", {
      organizationId: first.session.activeOrganizationId,
    });
    expect(intrusion.status).toBe(403);
    // better-auth answers a non-member by leaving no workspace active at all.
    expect((await current(two)).session.activeOrganizationId).toBeNull();
  });
});

describe("what a guest can't do", () => {
  it.each([
    ["/link-social", { provider: "google", callbackURL: "http://localhost:3000" }],
    ["/passkey/verify-registration", { response: {} }],
    ["/delete-user", { password: "anything" }],
    ["/organization/create", { name: "Another", slug: "another-guest-workspace" }],
    ["/update-user", { name: "Not a guest" }],
  ])("%s answers DEMO_ACCOUNT_LOCKED", async (path, body) => {
    const session = await guest();
    const answer = await session.auth<{ code: string }>(path, body);
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe("DEMO_ACCOUNT_LOCKED");
  });

  it("publishes nothing", async () => {
    const session = await guest();
    await expect(
      session.rpc.publish.upload({
        cutId: "0192f3a4-0000-7000-8000-000000000000",
        title: "Mine",
        description: "",
        hashtags: [],
        credits: "",
        visibility: "unlisted",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_DEMO_DISABLED" });
  });

  it("can't claim to be a guest, or say when it ends, in a sign-up or a profile edit", async () => {
    const session = createSession(harness);
    const email = newEmail();
    const claimed = await session.auth("/sign-up/email", {
      email,
      password: newPassword(),
      name: "Claims a guest's day",
      guestUntil: new Date().toISOString(),
    });
    expect(claimed.status).toBe(400);
    const guestSession = await guest();
    const edit = await guestSession.auth("/update-user", { guestUntil: null });
    expect(edit.status).toBe(400);
  });
});

describe("the demo's limits", () => {
  it("lets one address make two guests an hour", async () => {
    const browser = createSession(harness);
    await guest(browser);
    // The same browser, its cookies cleared, twice more.
    browser.useCookies(new Map());
    await guest(browser);
    browser.useCookies(new Map());
    const third = await browser.auth("/sign-in/guest", {});
    expect(third.status).toBe(429);
  });

  it("holds at most DEMO_GUEST_LIMIT guests at once, and makes room as days end", async () => {
    await expireGuests();
    for (let made = 0; made < GUEST_LIMIT; made++) {
      await guest();
    }
    const full = await createSession(harness).auth<{ code: string }>("/sign-in/guest", {});
    expect(full.status).toBe(503);
    expect(full.body.code).toBe("DEMO_GUESTS_FULL");
    // The shared demo account is the way in meanwhile.
    expect((await createSession(harness).rpc.system.info()).demo).not.toBeNull();

    await expireGuests();
    await guest();
  });
});
