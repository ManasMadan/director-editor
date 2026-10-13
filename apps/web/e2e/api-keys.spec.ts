import {
  BASE_URL,
  createWorkspace,
  expect,
  expectAccessible,
  inviteAndAccept,
  newDevice,
  settled,
  signUp,
  test,
} from "./support";

test("create an API key, call the REST API with it, then revoke it", async ({
  page,
  playwright,
}) => {
  await signUp(page);
  await createWorkspace(page, "Automated");
  await page.goto("/settings/api-keys");
  await settled(page);
  await expect(page.getByText("No API keys yet.")).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel("Name").fill("CI");
  await page.getByRole("checkbox", { name: "todos:read" }).check();
  await page.getByRole("checkbox", { name: "todos:write" }).check();
  await page.getByRole("combobox", { name: "Expires" }).click();
  await page.getByRole("option", { name: "In 30 days" }).click();
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog", { name: "Your new API key" });
  const key = (await dialog.getByTestId("api-key").textContent()) ?? "";
  expect(key).toMatch(/^bp_/);
  await dialog.getByRole("button", { name: "I've saved it" }).click();

  const keys = page.getByRole("list", { name: "API keys" });
  await expect(keys.getByText("CI", { exact: true })).toBeVisible();
  await expect(keys.getByText(key.slice(0, 6))).toBeVisible();
  await expect(keys.getByText("never used")).toBeVisible();
  // The key itself is never shown again.
  await expect(page.getByText(key)).toHaveCount(0);

  // A third party: no browser, no cookies, just the key.
  const api = await playwright.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { "x-api-key": key },
  });
  const created = await api.post("/api/v1/todos", { data: { title: "Made by a script" } });
  expect(created.status()).toBe(201);
  await page.goto("/dashboard");
  await expect(page.getByText("Made by a script")).toBeVisible();

  await page.goto("/settings/api-keys");
  await expect(keys.getByText(/last used/)).toBeVisible();
  await keys.getByRole("button", { name: "Revoke: CI" }).click();
  await page
    .getByRole("alertdialog", { name: "Revoke “CI”?" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.getByText("“CI” was revoked")).toBeVisible();
  await expect(page.getByText("No API keys yet.")).toBeVisible();
  expect((await api.get("/api/v1/todos")).status()).toBe(401);
  await api.dispose();
});

test("a key needs at least one scope", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings/api-keys");
  await page.getByLabel("Name").fill("Empty");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText("Choose at least one scope.")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("members don't manage API keys", async ({ page, browser }) => {
  await signUp(page);
  await createWorkspace(page, "Keyed");
  const teammate = await newDevice(browser);
  const user = await signUp(teammate.page);
  await inviteAndAccept(page, { page: teammate.page, user });

  await teammate.page.goto("/settings/members");
  await expect(teammate.page.getByRole("link", { name: "API keys" })).toHaveCount(0);
  await teammate.page.goto("/settings/api-keys");
  await expect(teammate.page.getByText("You don't have permission to do that.")).toBeVisible();
  await teammate.context.close();
});
