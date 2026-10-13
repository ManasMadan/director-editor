import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { WorkspaceMembersPage } from "@/modules/workspace";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import { addMember, teamWorkspace } from "./support";

const render = () => renderPage(<WorkspaceMembersPage />, { url: "/settings/members" });

describe("workspace members", () => {
  it("in a personal workspace: just you, nothing to invite or leave", async () => {
    const me = await signUp();
    const page = await render();
    await expect.element(page.getByText(me.email)).toBeVisible();
    await expect.element(page.getByText("You", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Owner", { exact: true })).toBeVisible();
    expect(page.getByRole("button", { name: "Leave workspace" }).query()).toBeNull();
    expect(page.getByText("Invite someone").query()).toBeNull();
  });

  it("lets an owner change roles, remove members, and invite people", async () => {
    await signUp();
    const workspace = await teamWorkspace();
    const colleague = await addMember(workspace.id);
    const stranger = await addMember(workspace.id, "auditor");
    const page = await render();
    await expect.element(page.getByText("No pending invitations.")).toBeVisible();

    // A role the app doesn't know: nothing is selected, and it can still be changed.
    await expect
      .element(page.getByRole("combobox", { name: `Role for ${stranger.name}` }))
      .toBeVisible();
    await userEvent.click(page.getByRole("combobox", { name: `Role for ${colleague.name}` }));
    await userEvent.click(page.getByRole("option", { name: "Admin" }));
    await expect.element(page.getByText("Role updated")).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await commands.sql<{ role: string }>("SELECT role FROM auth.member WHERE id = $1", [
              colleague.memberId,
            ])
          )[0]?.role,
      )
      .toBe("admin");

    const strangerRow = page.getByRole("listitem").filter({ hasText: stranger.email });
    await userEvent.click(strangerRow.getByRole("button", { name: "Remove" }));
    await expect.element(page.getByText("Member removed")).toBeVisible();
    await expect.element(page.getByText(stranger.email)).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Send invitation" }));
    await expect.element(page.getByText("Enter a valid email address")).toBeVisible();
    const invitee = `web-${crypto.randomUUID()}@example.com`;
    await userEvent.fill(page.getByLabelText("Email"), invitee);
    await userEvent.click(page.getByRole("combobox", { name: "Role" }));
    await userEvent.click(page.getByRole("option", { name: "Admin" }));
    await userEvent.click(page.getByRole("button", { name: "Send invitation" }));
    await expect.element(page.getByText(`Invitation sent to ${invitee}`)).toBeVisible();
    await expect.element(page.getByText("Invited as Admin", { exact: false })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await expect.element(page.getByText("Invitation cancelled")).toBeVisible();
    await expect.element(page.getByText("No pending invitations.")).toBeVisible();
  });

  it("says when a change no longer applies", async () => {
    await signUp();
    const workspace = await teamWorkspace();
    const colleague = await addMember(workspace.id);
    const invitee = `web-${crypto.randomUUID()}@example.com`;
    await commands.sql(
      `INSERT INTO auth.invitation (organization_id, email, role, expires_at, inviter_id)
       SELECT $1, $2, 'mystery', now() + interval '2 days', user_id FROM auth.member
       WHERE organization_id = $1 AND role = 'owner'`,
      [workspace.id, invitee],
    );
    const page = await render();
    await expect
      .element(page.getByText("Invited as No access (unknown role)", { exact: false }))
      .toBeVisible();

    // Someone else acted first.
    await commands.sql("DELETE FROM auth.member WHERE id = $1", [colleague.memberId]);
    await commands.sql("DELETE FROM auth.invitation WHERE email = $1", [invitee]);
    const failed = page.getByText("Something went wrong. Please try again.");
    await userEvent.click(page.getByRole("button", { name: "Remove" }));
    await expect.element(failed).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await expect.poll(() => failed.all().length).toBe(2);
  });

  it("refuses to invite someone already in the workspace", async () => {
    await signUp();
    const workspace = await teamWorkspace();
    const colleague = await addMember(workspace.id);
    const page = await render();
    await userEvent.fill(page.getByLabelText("Email"), colleague.email);
    await userEvent.click(page.getByRole("button", { name: "Send invitation" }));
    await expect.element(page.getByText("Something went wrong. Please try again.")).toBeVisible();
    expect(page.getByText("Invitation sent", { exact: false }).query()).toBeNull();
  });

  it("asks for an upgrade when the plan's member limit is reached", async () => {
    await signUp();
    const workspace = await teamWorkspace();
    await addMember(workspace.id);
    await addMember(workspace.id);
    const page = await render();
    await expect
      .element(page.getByText("Your plan allows 3 members.", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Upgrade to Pro" }))
      .toHaveAttribute("href", "/settings/billing");
  });

  it("lets a co-owner leave, moving them to another workspace first", async () => {
    await signUp();
    const workspace = await teamWorkspace();
    await addMember(workspace.id, "owner");
    const page = await render();
    await userEvent.click(page.getByRole("button", { name: "Leave workspace" }));
    await expect.element(page.getByText("You left the workspace")).toBeVisible();
    await expect.poll(currentUrl).toBe("/dashboard");
  });

  it("leaves even without another workspace to move to, and says when leaving fails", async () => {
    const me = await signUp();
    const workspace = await teamWorkspace();
    await addMember(workspace.id, "owner");
    await commands.sql(`DELETE FROM auth.organization WHERE slug = $1`, [`personal-${me.id}`]);
    const page = await render();
    await expect.element(page.getByRole("button", { name: "Leave workspace" })).toBeVisible();
    await commands.sql("DELETE FROM auth.member WHERE user_id = $1", [me.id]);
    await userEvent.click(page.getByRole("button", { name: "Leave workspace" }));
    await expect.element(page.getByText("You left the workspace")).not.toBeInTheDocument();
    await expect.element(page.getByText("You left the workspace")).not.toBeInTheDocument();
    expect(currentUrl()).toBe("/settings/members");
  });

  it("shows plain members everyone's role, and lets them leave", async () => {
    const me = await signUp();
    const workspace = await teamWorkspace();
    const boss = await addMember(workspace.id, "owner");
    const odd = await addMember(workspace.id, "auditor");
    await commands.sql("UPDATE auth.member SET role = 'member' WHERE user_id = $1", [me.id]);
    const page = await render();
    const bossRow = page.getByRole("listitem").filter({ hasText: boss.email });
    await expect.element(bossRow.getByText("Owner")).toBeVisible();
    await expect
      .element(
        page
          .getByRole("listitem")
          .filter({ hasText: odd.email })
          .getByText("No access (unknown role)"),
      )
      .toBeVisible();
    expect(page.getByRole("combobox").query()).toBeNull();
    expect(page.getByText("Invite someone").query()).toBeNull();
    await expect.element(page.getByRole("button", { name: "Leave workspace" })).toBeVisible();
  });
});
