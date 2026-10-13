/** Workspaces and their members, for the workspace and billing tests. */
import { commands } from "vitest/browser";
import { auth, newUser } from "../users";

/** A new team workspace, made the active one for the signed-in user. */
export async function teamWorkspace(name = `Team ${crypto.randomUUID().slice(0, 6)}`) {
  const workspace = await auth<{ id: string; name: string }>("/organization/create", {
    name,
    slug: `team-${crypto.randomUUID().slice(0, 8)}`,
  });
  await auth("/organization/set-active", { organizationId: workspace.id });
  return workspace;
}

/** Someone else in the workspace, added straight to the database (they never sign in). */
export async function addMember(organizationId: string, role = "member") {
  const person = newUser();
  const [user] = await commands.sql<{ id: string }>(
    `INSERT INTO auth."user" (name, email, email_verified, updated_at)
     VALUES ($1, $2, true, now()) RETURNING id::text`,
    [person.name, person.email],
  );
  const [member] = await commands.sql<{ id: string }>(
    `INSERT INTO auth.member (organization_id, user_id, role) VALUES ($1, $2, $3) RETURNING id::text`,
    [organizationId, user?.id, role],
  );
  return { ...person, userId: user?.id as string, memberId: member?.id as string };
}

/** Puts the workspace on the paid plan (what Stripe's webhook would record). */
export async function subscribe(
  organizationId: string,
  details: { status?: string; cancelAtPeriodEnd?: boolean; trialEnd?: string | null } = {},
) {
  await commands.sql(
    `INSERT INTO billing.subscription
       (id, org_id, plan, status, price_id, interval, quantity, current_period_end,
        cancel_at_period_end, trial_end, updated_at)
     VALUES ($1, $2, 'pro', $3, 'price_pro_monthly_web', 'month', 1, '2030-01-15T12:00:00Z',
             $4, $5, now())`,
    [
      `sub_${crypto.randomUUID().replaceAll("-", "")}`,
      organizationId,
      details.status ?? "active",
      details.cancelAtPeriodEnd ?? false,
      details.trialEnd ?? null,
    ],
  );
}

/** Sets the signed-in user's role in a workspace, behind the page's back. */
export const setRole = (organizationId: string, userId: string, role: string) =>
  commands.sql("UPDATE auth.member SET role = $3 WHERE organization_id = $1 AND user_id = $2", [
    organizationId,
    userId,
    role,
  ]);
