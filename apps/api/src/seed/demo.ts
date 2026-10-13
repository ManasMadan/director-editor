/**
 * The demo data (see src/seed.ts): two verified users, a shared workspace and a few
 * todos, created through the app's own auth configuration and services. Returns what it
 * created, or null when the data is already there.
 */
import { type OrgId, orgIdSchema, type UserId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import type { Database } from "@repo/nest-common";
import type { Auth } from "../auth/auth.module";
import { orgIdOf, userIdOf } from "../auth/ids";
import type { TodoService } from "../modules/todo";

/** Known credentials, printed by the seed; unlikely to be in any breach list. */
export const DEMO_PASSWORD = "boilerplate-demo-password";
export const DEMO_PEOPLE = [
  { name: "Demo User", email: "demo@example.com" },
  { name: "Team Mate", email: "teammate@example.com" },
] as const;

interface DemoUser {
  id: UserId;
  personalOrgId: OrgId;
}

export async function seedDemo({
  auth,
  database,
  todos,
}: {
  auth: Auth;
  database: Database;
  todos: TodoService;
}) {
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
  const [demo, teammate] = await Promise.all([signUp(DEMO_PEOPLE[0]), signUp(DEMO_PEOPLE[1])]);

  // better-auth throws when it can't create one.
  const team = {
    id: orgIdOf(
      required(
        await auth.api.createOrganization({
          body: { name: "Acme", slug: "acme", userId: demo.id },
        }),
        "the team workspace",
      ),
    ),
  };
  await auth.api.addMember({
    body: { organizationId: team.id, userId: teammate.id, role: "member" },
  });

  for (const title of ["Try the assistant", "Invite a teammate", "Connect an app"]) {
    await todos.create(demo.personalOrgId, demo.id, title);
  }
  for (const title of ["Plan the launch", "Write the changelog"]) {
    await todos.create(team.id, demo.id, title);
  }
  const done = await todos.create(team.id, teammate.id, "Set up billing");
  await todos.setCompleted(team.id, { id: done.id, completed: true, version: done.version });
  return { demo, teammate, teamId: team.id };
}
