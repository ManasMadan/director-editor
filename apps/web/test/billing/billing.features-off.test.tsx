import { expect, it } from "vitest";
import { BillingPage, UpgradeHint } from "@/modules/billing";
import { renderPage } from "../render";
import { signUp } from "../users";
import { teamWorkspace } from "../workspace/support";

it("says billing is off, and never asks to upgrade", async () => {
  await signUp();
  await teamWorkspace();
  const page = await renderPage(
    <>
      <BillingPage />
      <UpgradeHint entitlement="webhooks" />
    </>,
    { url: "/settings/billing" },
  );
  await expect
    .element(page.getByText("Billing is off on this deployment: everything is included."))
    .toBeVisible();
  expect(page.getByText("Upgrade", { exact: false }).query()).toBeNull();
});
