/**
 * Making Director's shared demo account (what it is and what it may not do: demo.ts), for
 * `bun run --filter @repo/api director:demo-account` (src/director-demo-account.ts).
 */
import { type OrgId, orgIdSchema, type UserId } from "@repo/contracts/ids";
import { type Database, tenantTx, transaction } from "@repo/db";
import { copySeedTemplates } from "../modules/director/seeds.repository";
import { emitEvent } from "../outbox";
import type { Auth } from "./auth.module";
import { DEMO_EMAIL } from "./demo";
import { userIdOf } from "./ids";

/** Its name, as the account menu shows it. */
const DEMO_NAME = "Director Demo";

/** What `director:demo-account` was asked to do, or why it won't. */
export type DemoCommand = { password: string; reset: boolean } | { refused: string };

const OPTIONS = new Set(["--force", "--reset"]);

/**
 * The command's arguments, read: it runs in production, elsewhere only with `--force`
 * (a local or test database gets a public demo account only on purpose), and needs the
 * password it gives the account.
 */
export function demoCommand(
  argv: readonly string[],
  nodeEnv: string,
  password: string | undefined,
): DemoCommand {
  const unknown = argv.find((option) => !OPTIONS.has(option));
  if (unknown) {
    return { refused: `Unknown option ${unknown}. Options: --force, --reset.` };
  }
  if (nodeEnv !== "production" && !argv.includes("--force")) {
    return {
      refused: "The demo account is for production; pass --force to make it in this environment.",
    };
  }
  if (!password) {
    return {
      refused: "DEMO_PASSWORD isn't set: set it to the password the demo account should have.",
    };
  }
  return { password, reset: argv.includes("--reset") };
}

interface Dependencies {
  auth: Auth;
  database: Database;
}

export type DemoAccountOutcome =
  | { outcome: "created" | "reset" }
  | { outcome: "updated"; templates: number };

/**
 * Makes the demo account, or brings it back to how it should be: verified, flagged, the
 * password `password`, and every seeded template in its library. Run again, it keeps the
 * account and everything done with it (its own Short, takes and cuts); with `reset`, it
 * deletes the account with its workspaces first and makes it again.
 */
export async function ensureDemoAccount(
  dependencies: Dependencies,
  { password, reset }: { password: string; reset: boolean },
): Promise<DemoAccountOutcome> {
  const { database } = dependencies;
  const found = await database.write.user.findUnique({
    where: { email: DEMO_EMAIL },
    select: { id: true },
  });
  if (found && !reset) {
    return {
      outcome: "updated",
      templates: await updateDemoAccount(dependencies, found, password),
    };
  }
  if (found) {
    await deleteDemoAccount(dependencies, userIdOf(found));
  }
  await createDemoAccount(dependencies, password);
  return { outcome: found ? "reset" : "created" };
}

/**
 * A new demo account, through better-auth's own adapter so the sign-up hooks run: its
 * personal workspace is made in the same transaction, with the seeded templates.
 */
async function createDemoAccount({ auth }: Dependencies, password: string) {
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser(
    { email: DEMO_EMAIL, name: DEMO_NAME, emailVerified: true, demo: true },
    { method: "admin" },
  );
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await context.password.hash(password),
  });
}

/** Puts the existing account right, keeping what was done with it; the seeds it copied. */
async function updateDemoAccount(
  { auth, database }: Dependencies,
  found: { id: string },
  password: string,
) {
  const userId = userIdOf(found);
  const { internalAdapter, password: hasher } = await auth.$context;
  // better-auth also rewrites the user its sessions hold in Redis, so one signed in
  // before the flag was set has it from the next request on.
  await internalAdapter.updateUser(userId, { name: DEMO_NAME, emailVerified: true, demo: true });
  const hash = await hasher.hash(password);
  if (await internalAdapter.findCredentialAccount(userId)) {
    await internalAdapter.updatePassword(userId, hash);
  } else {
    await internalAdapter.linkAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: hash,
    });
  }
  const orgId = await personalWorkspace(database, userId);
  // The name it was made with: nobody signed in to it can rename it, but the database can.
  await database.write.organization.update({ where: { id: orgId }, data: { name: DEMO_NAME } });
  return tenantTx(database.write, orgId, (tx) => copySeedTemplates(tx, orgId));
}

async function personalWorkspace(database: Database, userId: UserId): Promise<OrgId> {
  const workspace = await database.write.organization.findUnique({
    where: { slug: `personal-${userId}` },
    select: { id: true },
  });
  if (!workspace) {
    throw new Error(`The demo account has no personal workspace: run it with --reset.`);
  }
  return orgIdSchema.parse(workspace.id);
}

/**
 * Deletes the account and the workspaces it alone is in (as account deletion does), and
 * with them everything made there: tenant tables cascade from auth.organization. A
 * workspace it shares only loses its membership, with the account. Signs its sessions
 * out first, from Redis too.
 */
async function deleteDemoAccount({ auth, database }: Dependencies, userId: UserId) {
  const { internalAdapter } = await auth.$context;
  await transaction(database.write, async (tx) => {
    const workspaces = await tx.organization.findMany({
      where: { members: { some: { userId }, every: { userId } } },
      select: { id: true },
    });
    await tx.organization.deleteMany({ where: { id: { in: workspaces.map(({ id }) => id) } } });
    for (const { id } of workspaces) {
      const organizationId = orgIdSchema.parse(id);
      await emitEvent(
        tx,
        "org.deleted.v1",
        organizationId,
        { organizationId },
        { actorId: null, orgId: organizationId },
      );
    }
  });
  await internalAdapter.deleteUserSessions(userId);
  await internalAdapter.deleteUser(userId);
}
