/**
 * Signed-in users for the load tests (see src/load-users.ts): `count` verified users,
 * load-<n>@load.test, each with a personal workspace like any sign-up, and a fresh
 * session cookie for each. Existing users are reused, so running it again only mints
 * new sessions.
 */
import type { Database } from "@repo/nest-common";
import type { Auth } from "../auth/auth.module";

/** Only for these throwaway accounts; the session cookies are what k6 uses. */
const LOAD_PASSWORD = "load-test-password-not-secret";
export const loadEmail = (n: number) => `load-${n}@load.test`;

export async function signInLoadUsers(
  { auth, database }: { auth: Auth; database: Database },
  count: number,
): Promise<string[]> {
  const sessions: string[] = [];
  for (let n = 1; n <= count; n++) {
    const email = loadEmail(n);
    if (!(await database.write.user.findUnique({ where: { email } }))) {
      const { user } = await auth.api.signUpEmail({
        body: { name: `Load ${n}`, email, password: LOAD_PASSWORD, locale: "en", timezone: "UTC" },
      });
      await database.write.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    }
    const response = await auth.api.signInEmail({
      body: { email, password: LOAD_PASSWORD },
      asResponse: true,
    });
    const cookie = response.headers
      .getSetCookie()
      // Each header's first part: the cookie's name and value.
      .map((header) => header.replace(/;.*$/s, ""))
      .find((pair) => pair.includes("session_token="));
    if (!response.ok || !cookie) {
      throw new Error(`Signing in ${email} failed (${response.status})`);
    }
    sessions.push(cookie);
  }
  return sessions;
}
