import { createWorkspace, expect, inviteAndAccept, newDevice, signUp, test } from "./support";

test("a teammate's new todo appears without reloading", async ({ page, browser }) => {
  await signUp(page);
  await createWorkspace(page, "Live Team");
  const teammate = await newDevice(browser);
  const user = await signUp(teammate.page);
  await inviteAndAccept(page, { page: teammate.page, user });
  await expect(teammate.page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();

  await page.goto("/dashboard");
  await page.getByPlaceholder("What needs doing?").fill("Shipped live");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // No reload on the teammate's side: the realtime stream tells their page to refetch.
  await expect(teammate.page.getByRole("checkbox", { name: "Shipped live" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("checkbox", { name: "Shipped live" }).click();
  await expect(teammate.page.getByRole("checkbox", { name: "Shipped live" })).toBeChecked({
    timeout: 15_000,
  });
  await teammate.context.close();
});

test("another tab of the same user stays in sync", async ({ page, context }) => {
  await signUp(page);
  const other = await context.newPage();
  await other.goto("/dashboard");
  await page.getByPlaceholder("What needs doing?").fill("Two tabs");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(other.getByRole("checkbox", { name: "Two tabs" })).toBeVisible({ timeout: 15_000 });
  await other.getByRole("button", { name: "Delete Two tabs" }).click();
  await expect(page.getByRole("checkbox", { name: "Two tabs" })).toHaveCount(0, {
    timeout: 15_000,
  });
});

test("other workspaces' changes don't leak into the stream", async ({ page, browser }) => {
  await signUp(page);
  const stranger = await newDevice(browser);
  await signUp(stranger.page);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/rpc/todo/list")) {
      requests.push(request.url());
    }
  });
  await page.waitForTimeout(1_000);
  const before = requests.length;
  await stranger.page.getByPlaceholder("What needs doing?").fill("Not yours");
  await stranger.page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(stranger.page.getByRole("checkbox", { name: "Not yours" })).toBeVisible();
  await page.waitForTimeout(3_000);
  expect(requests.length).toBe(before);
  await expect(page.getByRole("checkbox", { name: "Not yours" })).toHaveCount(0);
  await stranger.context.close();
});
