/**
 * The demo data (see src/seed.ts): a verified user with their personal workspace,
 * created through the app's own auth configuration. Returns what it created, or null
 * when the data is already there.
 */
import { type OrgId, orgIdSchema, type UserId } from "@repo/contracts/ids";
import type { Database } from "@repo/nest-common";
import type { Auth } from "../auth/auth.module";
import { userIdOf } from "../auth/ids";

/** Known credentials, printed by the seed; unlikely to be in any breach list. */
export const DEMO_PASSWORD = "director-editor-demo-password";
export const DEMO_PEOPLE = [{ name: "Demo User", email: "demo@example.com" }] as const;

interface DemoUser {
  id: UserId;
  personalOrgId: OrgId;
}

export async function seedDemo({ auth, database }: { auth: Auth; database: Database }) {
  if (await database.write.user.findUnique({ where: { email: DEMO_PEOPLE[0].email } })) {
    return null;
  }
  const signUp = async (person: (typeof DEMO_PEOPLE)[number]): Promise<DemoUser> => {
    // Signs up exactly as the app does (personal workspace, audit event); the emailed
    // code is skipped by marking the address verified.
    const { user } = await auth.api.signUpEmail({
      body: { ...person, password: DEMO_PASSWORD, locale: "en", timezone: "UTC" },
    });
    await database.write.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    const personal = await database.write.member.findFirstOrThrow({
      where: { userId: user.id },
      select: { organizationId: true },
    });
    return { id: userIdOf(user), personalOrgId: orgIdSchema.parse(personal.organizationId) };
  };
  return { demo: await signUp(DEMO_PEOPLE[0]) };
}
