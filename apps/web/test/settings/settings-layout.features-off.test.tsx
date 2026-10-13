import { expect, it } from "vitest";
import { SettingsLayout } from "@/modules/settings";
import { renderPage } from "../render";
import { signUp } from "../users";

it("has no billing tab when billing is off", async () => {
  await signUp();
  const page = await renderPage(
    <SettingsLayout>
      <p>profile form</p>
    </SettingsLayout>,
    { url: "/settings" },
  );
  await expect.element(page.getByRole("link", { name: "Audit log" })).toBeVisible();
  expect(page.getByRole("link", { name: "Billing" }).query()).toBeNull();
});
