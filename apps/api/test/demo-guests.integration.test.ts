/**
 * Director's demo guests (src/auth/guest.ts): one tap signs a browser in as a private
 * guest with its own workspace and the seeded templates, for a day, with the demo's
 * restrictions; guests never share anything; and the limits per address and in all hold.
 */
import { ORPCError } from "@orpc/client";
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
  harness = await startApi(30, {
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

/**
 * Ends every live guest's day, so a test starts with the cap free: in the database, and
 * their places in Valkey (LIVE_GUESTS_KEY in src/auth/guest.ts, named here: importing the
 * API's modules before startApi would read its environment too early).
 */
async function expireGuests() {
  await database.write.user.updateMany({
    where: { guestUntil: { gt: new Date() } },
    data: { guestUntil: new Date(Date.now() - 1000) },
  });
  await harness.redis.del("demo:live-guests");
}

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

  it("ends the guest's session with its day even when the browser sends only the session cookie", async () => {
    const session = await guest();
    const { user, session: before } = await current(session);
    // Without the "don't remember me" cookie, better-auth refreshes the session at once,
    // by its 7 days; the server keeps it to the guest's day all the same.
    const cookies = session.cookies();
    cookies.delete("better-auth.dont_remember");
    session.useCookies(cookies);
    const after = await current(session);
    expect(after.session.expiresAt).toBe(before.expiresAt);
    expect(new Date(after.session.expiresAt).getTime()).toBe(new Date(user.guestUntil).getTime());
    // And Valkey's copy, which better-auth reads first, goes when the day ends.
    const token = decodeURIComponent(cookies.get("better-auth.session_token") ?? "").split(".")[0];
    const ttl = await harness.redis.ttl(`auth:${token}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(DAY_S);
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
  // Director is off here, so each turn answers FEATURE_DISABLED, but only once the call's
  // rate limits are spent: what's counted is the same.
  const chatTurn = (session: Session) =>
    session.rpc.director
      .chat({
        videoId: "dQw4w9WgXcQ",
        shotIndex: 0,
        turn: { kind: "said", text: "Hi" },
        adaptations: [],
        recent: [],
        answers: [],
      })
      .then(
        () => "answered",
        (error: unknown) => (error instanceof ORPCError ? String(error.code) : String(error)),
      );

  it("holds a guest to fewer turns on Director's slower line than a member", async () => {
    const session = await guest();
    const turns: string[] = [];
    for (let i = 0; i < 7; i++) {
      turns.push(await chatTurn(session));
    }
    expect(turns).toEqual([...Array<string>(6).fill("FEATURE_DISABLED"), "RATE_LIMITED"]);

    const member = createSession(harness);
    const email = newEmail();
    await member.auth("/sign-up/email", { email, password: newPassword(), name: "Member" });
    const { otp } = await takeOtp(harness, email);
    await member.auth("/email-otp/verify-email", { email, otp });
    const theirs: string[] = [];
    for (let i = 0; i < 11; i++) {
      theirs.push(await chatTurn(member));
    }
    expect(theirs).toEqual([...Array<string>(10).fill("FEATURE_DISABLED"), "RATE_LIMITED"]);
  });

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

    // A day ends: its place frees up, and the next browser gets it.
    const [first] = await harness.redis.zrange("demo:live-guests", "0", "0");
    await harness.redis.zadd("demo:live-guests", Date.now() - 1000, first ?? "");
    await guest();
    expect((await createSession(harness).auth("/sign-in/guest", {})).status).toBe(503);
  });

  it("still holds the limit after Valkey loses the count: it's recounted from Postgres", async () => {
    for (let made = 0; made < GUEST_LIMIT; made++) {
      await guest();
    }
    // As after a restart of Valkey without its data.
    await harness.redis.del("demo:live-guests");
    const full = await createSession(harness).auth<{ code: string }>("/sign-in/guest", {});
    expect(full.status).toBe(503);
    expect(await harness.redis.zcard("demo:live-guests")).toBe(GUEST_LIMIT);
  });

  it("holds the limit when many browsers ask at once", async () => {
    const answers = await Promise.all(
      Array.from({ length: GUEST_LIMIT * 2 }, () =>
        createSession(harness).auth("/sign-in/guest", {}),
      ),
    );
    const made = answers.filter((answer) => answer.status === 200);
    expect(made).toHaveLength(GUEST_LIMIT);
    expect(answers.filter((answer) => answer.status === 503)).toHaveLength(GUEST_LIMIT);
  });
});
