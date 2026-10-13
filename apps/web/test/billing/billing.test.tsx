import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { BillingPage } from "@/modules/billing";
import { cleanup, renderPage } from "../render";
import { auth, signUp } from "../users";
import { addMember, subscribe, teamWorkspace } from "../workspace/support";

const render = (url = "/settings/billing") => renderPage(<BillingPage />, { url });

describe("billing", () => {
  it("shows the free plan, pays through Stripe's checkout, then shows Pro and its invoice", async () => {
    await signUp();
    const workspace = await teamWorkspace("Acme");
    const page = await render();
    await expect.element(page.getByText("The plan for Acme.", { exact: false })).toBeVisible();
    await expect.element(page.getByText("Free", { exact: true })).toBeVisible();
    await expect.element(page.getByText("1 of 3 members")).toBeVisible();
    await expect.element(page.getByText("Not included")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Upgrade, billed monthly" }));
    const [checkout] = await expect
      .poll(commands.hardNavigations)
      .toHaveLength(1)
      .then(commands.hardNavigations);
    expect(checkout).toMatch(/\/checkout\/cs_\w+$/);

    // Paying on Stripe's page; its webhook would then record the subscription.
    await fetch(`${checkout}/pay`, { method: "POST", mode: "no-cors" });
    await subscribe(workspace.id);
    cleanup();
    const paid = await render("/settings/billing?checkout=done");
    await expect
      .element(paid.getByText("Thanks! Your plan will update in a moment."))
      .toBeVisible();
    await expect.element(paid.getByText("Pro", { exact: true })).toBeVisible();
    await expect.element(paid.getByText("Renews on January 15, 2030")).toBeVisible();
    await expect.element(paid.getByText("1 member, no limit")).toBeVisible();
    await expect.element(paid.getByText("Included", { exact: true })).toBeVisible();
    await expect.element(paid.getByText("Paid")).toBeVisible();
    // The first subscription starts with a free trial.
    await expect.element(paid.getByText("$0.00")).toBeVisible();
    await expect
      .element(paid.getByRole("link", { name: "View" }))
      .toHaveAttribute("target", "_blank");

    // Invoices Stripe keeps as drafts have no page yet, and a status Stripe adds later
    // shows as it is.
    const { subscriptions } = await commands.fakeStripe<{
      subscriptions: { id: string; metadata: { orgId?: string } }[];
    }>("/__fake/state");
    const subscription = subscriptions.find((s) => s.metadata.orgId === workspace.id);
    await commands.fakeStripe(
      `/__fake/subscriptions/${subscription?.id}/invoice?status=draft`,
      "POST",
    );
    await commands.fakeStripe(
      `/__fake/subscriptions/${subscription?.id}/invoice?status=held`,
      "POST",
    );
    cleanup();
    const later = await render();
    await expect.element(later.getByText("Draft")).toBeVisible();
    await expect.element(later.getByText("held")).toBeVisible();
    // The paid and the held one have a page; the draft doesn't.
    expect(later.getByRole("link", { name: "View" }).all()).toHaveLength(2);

    await userEvent.click(later.getByRole("button", { name: "Manage billing" }));
    await expect
      .poll(async () => (await commands.hardNavigations())[1])
      .toMatch(/\/portal\/bps_\w+$/);
  });

  it("starts a yearly checkout", async () => {
    await signUp();
    await teamWorkspace();
    const page = await render();
    await userEvent.click(page.getByRole("button", { name: "Upgrade, billed yearly" }));
    await expect
      .poll(async () => (await commands.hardNavigations())[0])
      .toMatch(/\/checkout\/cs_\w+$/);
  });

  it.each([
    [{ status: "trialing", trialEnd: "2030-01-01T12:00:00Z" }, "Free trial until January 1, 2030"],
    [{ status: "active", cancelAtPeriodEnd: true }, "Cancelled: Pro stays until January 15, 2030"],
    [{ status: "unpaid" }, "Payments failed, so the plan has lapsed."],
    [{ status: "incomplete" }, "Cancelled"],
  ])("describes a subscription that is %o", async (details, text) => {
    await signUp();
    const workspace = await teamWorkspace();
    await subscribe(workspace.id, details);
    const page = await render();
    await expect.element(page.getByText(text, { exact: true })).toBeVisible();
    // No payment ever went through Stripe for it.
    await expect.element(page.getByText("No invoices yet.")).toBeVisible();
  });

  it("warns when the last payment failed, and says when there's no Stripe customer to manage", async () => {
    await signUp();
    const workspace = await teamWorkspace();
    await subscribe(workspace.id, { status: "past_due" });
    const page = await render();
    await expect
      .element(page.getByRole("alert").getByText("The last payment failed.", { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Manage billing" }));
    await expect
      .element(page.getByText("This workspace doesn't have a paid plan yet."))
      .toBeVisible();
  });

  it("says when the workspace was subscribed meanwhile", async () => {
    await signUp();
    const workspace = await teamWorkspace();
    const page = await render();
    await expect
      .element(page.getByRole("button", { name: "Upgrade, billed monthly" }))
      .toBeVisible();
    await subscribe(workspace.id);
    await userEvent.click(page.getByRole("button", { name: "Upgrade, billed monthly" }));
    await expect
      .element(page.getByText("This workspace already has a paid plan.", { exact: false }))
      .toBeVisible();
  });

  it("is for owners and admins only", async () => {
    const owner = await signUp();
    const workspace = await teamWorkspace();
    const member = await addMember(workspace.id);
    await commands.sql(`UPDATE auth.member SET role = 'owner' WHERE id = $1`, [member.memberId]);
    await commands.sql(`UPDATE auth.member SET role = 'member' WHERE user_id = $1`, [owner.id]);
    const page = await render();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("You don't have permission to do that.");
    await auth("/sign-out");
  });
});
