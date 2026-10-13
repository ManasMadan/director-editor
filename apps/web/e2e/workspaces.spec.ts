import { createWorkspace, expect, inviteAndAccept, newDevice, signUp, test } from "./support";

test("create a workspace, switch between workspaces, and each keeps its own todos", async ({
  page,
}) => {
  await signUp(page);
  await page.getByPlaceholder("What needs doing?").fill("Personal errand");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Personal errand" })).toBeVisible();

  await createWorkspace(page, "Acme");
  await expect(page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();
  await page.getByPlaceholder("What needs doing?").fill("Team task");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Team task" })).toBeVisible();

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Personal" }).click();
  await expect(page.getByRole("checkbox", { name: "Personal errand" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Team task" })).toHaveCount(0);
});

test("the personal workspace can't be shared or deleted", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings/workspace");
  await expect(
    page.getByText("This is your personal workspace. It can't be shared or deleted."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete workspace" })).toHaveCount(0);
  await page.goto("/settings/members");
  await expect(page.getByRole("button", { name: "Send invitation" })).toHaveCount(0);
});

test("invite a member by email; roles decide what they can see", async ({ page, browser }) => {
  await signUp(page);
  await createWorkspace(page, "Roles Inc");
  const teammate = await newDevice(browser);
  const user = await signUp(teammate.page);
  await inviteAndAccept(page, { page: teammate.page, user });

  // A member sees the workspace, not its admin tools.
  await teammate.page.goto("/settings/members");
  await expect(teammate.page.getByText(user.email)).toBeVisible();
  await expect(teammate.page.getByRole("link", { name: "Webhooks" })).toHaveCount(0);
  await teammate.page.goto("/settings/audit");
  await expect(teammate.page.getByText("You don't have permission to do that.")).toBeVisible();

  // Promoted to admin, they get them.
  await page.goto("/settings/members");
  await page.getByRole("combobox", { name: `Role for ${user.name}` }).click();
  await page.getByRole("option", { name: "Admin" }).click();
  await expect(page.getByText("Role updated")).toBeVisible();
  await teammate.page.goto("/settings/members");
  await expect(teammate.page.getByRole("link", { name: "Audit log" })).toBeVisible();
  await teammate.context.close();
});

test("a removed member is moved to their own workspace on their next request", async ({
  page,
  browser,
}) => {
  await signUp(page);
  await createWorkspace(page, "Leavers");
  await page.getByPlaceholder("What needs doing?").fill("Secret plan");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const teammate = await newDevice(browser);
  const user = await signUp(teammate.page);
  await inviteAndAccept(page, { page: teammate.page, user });
  await expect(teammate.page.getByRole("checkbox", { name: "Secret plan" })).toBeVisible();

  await page.goto("/settings/members");
  await page
    .getByRole("listitem")
    .filter({ hasText: user.email })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByText("Member removed")).toBeVisible();

  await teammate.page.reload();
  await expect(teammate.page.getByRole("button", { name: "Workspace", exact: true })).toContainText(
    "Personal",
  );
  await expect(teammate.page.getByRole("checkbox", { name: "Secret plan" })).toHaveCount(0);
  await teammate.context.close();
});

test("cancel a pending invitation", async ({ page }) => {
  await signUp(page);
  await createWorkspace(page, "Pending Co");
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill("someone@example.com");
  await page.getByRole("button", { name: "Send invitation" }).click();
  const pending = page
    .locator("[data-slot=card]", { hasText: "Pending invitations" })
    .getByRole("listitem")
    .filter({ hasText: "someone@example.com" });
  await expect(pending).toBeVisible();
  await pending.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Invitation cancelled")).toBeVisible();
  await expect(page.getByText("No pending invitations.")).toBeVisible();
});

test("rename and delete a workspace", async ({ page }) => {
  await signUp(page);
  await createWorkspace(page, "Temp");
  await page.goto("/settings/workspace");
  await page.getByLabel("Name", { exact: true }).fill("Temporary");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Workspace saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Workspace", exact: true })).toContainText(
    "Temporary",
  );

  const remove = page.getByRole("button", { name: "Delete workspace" });
  await expect(remove).toBeDisabled();
  await page.getByLabel("Type the workspace name to confirm").fill("Temporary");
  await remove.click();
  await expect(page.getByText("Workspace deleted")).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("button", { name: "Workspace", exact: true })).toContainText(
    "Personal",
  );
});

test("a member can leave a workspace", async ({ page, browser }) => {
  await signUp(page);
  await createWorkspace(page, "Exit Ltd");
  const teammate = await newDevice(browser);
  const user = await signUp(teammate.page);
  await inviteAndAccept(page, { page: teammate.page, user });
  await teammate.page.goto("/settings/members");
  await teammate.page.getByRole("button", { name: "Leave workspace" }).click();
  await expect(teammate.page.getByText("You left the workspace")).toBeVisible();
  await expect(teammate.page.getByRole("button", { name: "Workspace", exact: true })).toContainText(
    "Personal",
  );
  await teammate.context.close();
});

test("the audit log shows what happened and who did it", async ({ page }) => {
  const user = await signUp(page);
  await createWorkspace(page, "Audited");
  await page.getByPlaceholder("What needs doing?").fill("Traceable");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.goto("/settings/audit");
  // Events reach the log through the outbox relay, within a moment.
  await expect(async () => {
    await page.reload();
    await expect(
      page.getByRole("row").filter({ hasText: "Created the todo “Traceable”" }),
    ).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(
    page.getByRole("row").filter({ hasText: "Created the todo “Traceable”" }),
  ).toContainText(user.name);
  await expect(
    page.getByRole("row").filter({ hasText: "Created the workspace “Audited”" }),
  ).toBeVisible();
});
