/**
 * Rotating better-auth's secret (src/auth/secrets.ts): with BETTER_AUTH_SECRETS set, the
 * API encrypts what it stores under the newest secret, and still reads what was written
 * before the rotation under BETTER_AUTH_SECRET alone.
 */
import { required } from "@repo/contracts/objects";
import { totp } from "@repo/testing/totp";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi, takeOtp } from "./harness";

const NEWEST = "n".repeat(40);

let harness: Harness;
beforeAll(async () => {
  harness = await startApi(4, { BETTER_AUTH_SECRETS: `2:${NEWEST}` });
});
afterAll(() => harness?.close());

/** A verified user with two-step verification on; `code` makes their current TOTP code. */
async function twoFactorUser() {
  const session = createSession(harness);
  const email = newEmail();
  const password = newPassword();
  await session.auth("/sign-up/email", { email, password, name: "Rotating User" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  const enabled = await session.auth<{ totpURI: string }>("/two-factor/enable", { password });
  const secret = required(new URL(enabled.body.totpURI).searchParams.get("secret"), "the secret");
  expect((await session.auth("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
  return { email, password, code: () => totp(secret) };
}

/** Runs one statement as the API's own role. */
async function query<T extends pg.QueryResultRow>(text: string, values: unknown[]) {
  const client = new pg.Client({ connectionString: harness.testDb.urlFor("app_api") });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

const storedSecret = async (email: string) =>
  required(
    (
      await query<{ secret: string }>(
        `SELECT t.secret FROM auth.two_factor t JOIN auth."user" u ON u.id = t.user_id WHERE u.email = $1`,
        [email],
      )
    )[0],
    "the two-factor row",
  ).secret;

describe("a rotated better-auth secret", () => {
  it("encrypts under the newest secret", async () => {
    const { email } = await twoFactorUser();
    const stored = await storedSecret(email);
    expect(stored).toMatch(/^\$ba\$2\$/);
    // Readable with the newest secret alone.
    const newestOnly = { keys: new Map([[2, NEWEST]]), currentVersion: 2 };
    expect(await symmetricDecrypt({ key: newestOnly, data: stored })).not.toBe("");
  });

  it("still reads a value written before the rotation", async () => {
    const { email, password, code } = await twoFactorUser();
    // The same secret as better-auth stored it with BETTER_AUTH_SECRET alone.
    const legacy = required(process.env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
    const plain = await symmetricDecrypt({
      key: { keys: new Map([[2, NEWEST]]), currentVersion: 2 },
      data: await storedSecret(email),
    });
    await query(
      `UPDATE auth.two_factor SET secret = $2 WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [email, await symmetricEncrypt({ key: legacy, data: plain })],
    );

    const session = createSession(harness);
    const signIn = await session.auth<{ twoFactorRedirect?: boolean }>("/sign-in/email", {
      email,
      password,
    });
    expect(signIn.body.twoFactorRedirect).toBe(true);
    expect((await session.auth("/two-factor/verify-totp", { code: code() })).status).toBe(200);
    expect(await session.rpc.user.me()).toMatchObject({ email });
  });
});
