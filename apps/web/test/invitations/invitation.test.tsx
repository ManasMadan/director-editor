import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { InvitationPage } from "@/modules/invitations";
import { currentUrl, renderPage } from "../render";
import { auth, currentSession, newUser, signOut, signUp } from "../users";

/** A workspace that invited a new user, who is signed in on the page. */
async function invited() {
  await signUp();
  const name = `Team ${crypto.randomUUID().slice(0, 8)}`;
  const workspace = await auth<{ id: string }>("/organization/create", {
    name,
    slug: `team-${crypto.randomUUID().slice(0, 8)}`,
  });
  const invitee = newUser();
  await auth("/organization/invite-member", {
    email: invitee.email,
    role: "member",
    organizationId: workspace.id,
  });
  const { acceptUrl } = await commands.takeNotification<{ acceptUrl: string }>(
    "org.invitation",
    invitee.email,
  );
  await signOut();
  await signUp(invitee);
  const id = new URL(acceptUrl).pathname.split("/").at(-1) as string;
  return { id, name, workspaceId: workspace.id };
}

describe("an invitation", () => {
  it("joins the workspace and makes it the active one", async () => {
    const { id, name, workspaceId } = await invited();
    const page = await renderPage(<InvitationPage id={id} />, { url: `/invitations/${id}` });
    await expect.element(page.getByText(`Join ${name} to start collaborating.`)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Accept invitation" }));
    await expect.element(page.getByText(`You joined ${name}`)).toBeVisible();
    await expect.poll(currentUrl).toBe("/dashboard");
    const session = await currentSession();
    expect(session.session.activeOrganizationId).toBe(workspaceId);
  });

  it("can be declined", async () => {
    const { id } = await invited();
    const page = await renderPage(<InvitationPage id={id} />, { url: `/invitations/${id}` });
    await userEvent.click(page.getByRole("button", { name: "Decline" }));
    await expect.poll(currentUrl).toBe("/dashboard");
  });

  it("says when it was already answered elsewhere", async () => {
    const { id } = await invited();
    const page = await renderPage(<InvitationPage id={id} />, { url: `/invitations/${id}` });
    await expect.element(page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
    // Answered in another tab: both buttons now fail.
    await auth("/organization/reject-invitation", { invitationId: id });
    // better-auth's invitation codes have no translation of their own yet.
    const failed = page.getByText("Something went wrong. Please try again.");
    await userEvent.click(page.getByRole("button", { name: "Accept invitation" }));
    await expect.poll(() => failed.elements().length).toBe(1);
    await userEvent.click(page.getByRole("button", { name: "Decline" }));
    await expect.poll(() => failed.elements().length).toBe(2);
    expect(currentUrl()).toBe(`/invitations/${id}`);
  });

  it("says when it doesn't exist", async () => {
    await signUp();
    const id = crypto.randomUUID();
    const page = await renderPage(<InvitationPage id={id} />, { url: `/invitations/${id}` });
    await expect
      .element(page.getByText("This invitation is invalid or has expired."))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Accept invitation" }).query()).toBeNull();
  });
});
