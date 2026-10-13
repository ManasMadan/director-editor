import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { authApi, expect, mailbox, newDevice, newUser, signIn, signUp, test } from "./support";

// The organization UI arrives with the admin module; until then the owner invites
// through the auth API, and everything the invitee sees is the real UI.
async function inviteToNewTeam(owner: Page, email: string) {
  const slug = `team-${randomUUID().slice(0, 8)}`;
  const org = await authApi<{ id: string }>(owner, "/organization/create", {
    name: "Acme Team",
    slug,
  });
  const inbox = await mailbox(email);
  await authApi(owner, "/organization/invite-member", {
    email,
    role: "member",
    organizationId: org.id,
  });
  const { Text } = await inbox.next();
  const link = /(https?:\/\/\S+\/invitations\/[0-9a-f-]{36})/.exec(Text)?.[1];
  expect(link, "an invitation link in the email").toBeDefined();
  return { org, link: link as string };
}

test("accept an invitation and work in the team's space", async ({ page, browser }) => {
  await signUp(page);
  const invitee = newUser();
  const { org, link } = await inviteToNewTeam(page, invitee.email);
  // The owner puts a todo in the team space.
  await authApi(page, "/organization/set-active", { organizationId: org.id });
  expect(
    (await page.request.post("/api/v1/todos", { data: { title: "Team todo" } })).status(),
  ).toBe(201);

  const device = await newDevice(browser);
  await signUp(device.page, invitee);
  await device.page.goto(new URL(link).pathname);
  await expect(device.page.getByText("Join Acme Team to start collaborating.")).toBeVisible();
  await device.page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(device.page.getByText("You joined Acme Team")).toBeVisible();
  await expect(device.page).toHaveURL(/\/dashboard/);
  await expect(device.page.getByRole("checkbox", { name: "Team todo" })).toBeVisible();
  await device.context.close();
});

test("an invitee without an account signs up and comes back to the invitation", async ({
  page,
  browser,
}) => {
  await signUp(page);
  const invitee = newUser();
  const { link } = await inviteToNewTeam(page, invitee.email);

  const device = await newDevice(browser);
  await device.page.goto(new URL(link).pathname);
  await expect(device.page).toHaveURL(/\/sign-in\?next=%2Finvitations%2F/);
  await device.page.getByRole("link", { name: "Create account" }).click();
  await expect(device.page).toHaveURL(/\/sign-up\?next=%2Finvitations%2F/);
  await signUp(device.page, invitee, { expectUrl: /\/invitations\// });
  await expect(device.page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
  await device.context.close();
});

test("decline an invitation", async ({ page, browser }) => {
  await signUp(page);
  const invitee = newUser();
  const { link } = await inviteToNewTeam(page, invitee.email);
  const device = await newDevice(browser);
  await signUp(device.page, invitee);
  await device.page.goto(new URL(link).pathname);
  await device.page.getByRole("button", { name: "Decline" }).click();
  await expect(device.page).toHaveURL(/\/dashboard/);
  await device.page.goto(new URL(link).pathname);
  await expect(device.page.getByText("This invitation is invalid or has expired.")).toBeVisible();
  await device.context.close();
});

test("someone else can't use an invitation", async ({ page, browser }) => {
  await signUp(page);
  const { link } = await inviteToNewTeam(page, newUser().email);
  const stranger = await newDevice(browser);
  await signUp(stranger.page);
  await stranger.page.goto(new URL(link).pathname);
  await expect(stranger.page.getByText("This invitation is invalid or has expired.")).toBeVisible();
  await expect(stranger.page.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);
  await stranger.context.close();
});

test("an unknown invitation says it's invalid", async ({ page }) => {
  await signUp(page);
  await page.goto(`/invitations/${randomUUID()}`);
  await expect(page.getByText("This invitation is invalid or has expired.")).toBeVisible();
});

test("signing in with the invited account also returns to the invitation", async ({
  page,
  browser,
}) => {
  await signUp(page);
  const invitee = newUser();
  const setup = await newDevice(browser);
  await signUp(setup.page, invitee);
  await setup.context.close();
  const { link } = await inviteToNewTeam(page, invitee.email);

  const device = await newDevice(browser);
  await device.page.goto(new URL(link).pathname);
  await signIn(device.page, invitee, { expectUrl: /\/invitations\// });
  await device.context.close();
});
