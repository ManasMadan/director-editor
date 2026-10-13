/** The app's screens (rendered for the web) against the real stack. */
import { totp } from "@repo/testing/totp";
import { addPasskeyAuthenticator, expect, newUser, nextCode, signUp, test } from "./support";

test("sign up, verify the email and land on the todos", async ({ page }) => {
  await signUp(page);
  await expect(page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();
});

test("add, complete and delete a todo", async ({ page }) => {
  await signUp(page);
  await page.getByPlaceholder("What needs doing?").fill("Buy milk");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const todo = page.getByRole("checkbox", { name: "Buy milk" });
  await expect(todo).toBeVisible();
  await todo.click();
  await expect(todo).toBeChecked();
  // The same data the web app shows: through the shared API.
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Buy milk" })).toBeChecked();
  await page.getByRole("button", { name: "Delete Buy milk" }).click();
  await expect(page.getByRole("checkbox", { name: "Buy milk" })).toHaveCount(0);
});

test("a todo title is validated before it's sent", async ({ page }) => {
  await signUp(page);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
});

test("sign out, then sign in again", async ({ page }) => {
  const user = await signUp(page);
  await page.getByRole("tab", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible();

  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("That email and password don't match.");

  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByPlaceholder("What needs doing?")).toBeVisible();
});

test("reset a forgotten password and sign in with the new one", async ({ page }) => {
  const user = await signUp(page);
  await page.getByRole("tab", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByText("Reset your password")).toBeVisible();

  const sent = new Date();
  await page.getByLabel("Email").filter({ visible: true }).fill(user.email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText("Choose a new password")).toBeVisible();
  const password = newUser().password;
  await page.getByLabel("Verification code").fill(await nextCode(user.email, sent));
  await page.getByLabel("New password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Password updated. Sign in with your new password.")).toBeVisible();

  // The old password no longer works; the new one does. On the web the screens passed
  // through stay mounted (hidden), so the fields are the visible ones.
  await page.getByLabel("Email").filter({ visible: true }).fill(user.email);
  await page.getByLabel("Password").filter({ visible: true }).fill(user.password);
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("That email and password don't match.");
  await page.getByLabel("Password").filter({ visible: true }).fill(password);
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByPlaceholder("What needs doing?")).toBeVisible();
});

test("add a passkey in settings, then sign in with it", async ({ page }) => {
  await addPasskeyAuthenticator(page);
  await signUp(page);
  await page.getByRole("tab", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Passkey added")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByPlaceholder("What needs doing?")).toBeVisible();
});

test("signed-out users are sent to sign in", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("Welcome back")).toBeVisible();
});

test("an unverified user signing in is asked for the emailed code", async ({ page }) => {
  const user = newUser();
  await page.goto("/sign-up");
  await page.getByLabel("Full name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
});

test("the language can be changed, and follows the account", async ({ page }) => {
  await signUp(page);
  await page.getByRole("tab", { name: /Settings/ }).click();
  await page.getByRole("radio", { name: "Español" }).click();
  await expect(page.getByRole("radio", { name: "Español" })).toBeChecked();
  await expect(page.getByText("Idioma")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Tareas/ })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Idioma")).toBeVisible();
});

test("push notifications explain they need a real device", async ({ page }) => {
  await signUp(page);
  await page.getByRole("tab", { name: /Settings/ }).click();
  await expect(
    page.getByText("Notifications need a real device, not a simulator or the web."),
  ).toBeVisible();
});

/** Calls a better-auth endpoint as the page's signed-in user (setup the app has no UI for). */
async function auth<T>(page: import("@playwright/test").Page, path: string, body: unknown) {
  const response = await page.request.post(`/api/auth${path}`, {
    data: body,
    headers: { origin: new URL(page.url()).origin },
  });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

test("switch workspace: each keeps its own todos", async ({ page }) => {
  await signUp(page);
  await page.getByPlaceholder("What needs doing?").fill("Personal errand");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Personal errand" })).toBeVisible();

  await auth(page, "/organization/create", { name: "Acme", slug: `acme-${Date.now()}` });
  await page.getByRole("tab", { name: /Settings/ }).click();
  await page.getByRole("radio", { name: "Acme" }).click();
  await expect(page.getByRole("radio", { name: "Acme" })).toBeChecked();
  await page.getByRole("tab", { name: /Todos/ }).click();
  await expect(page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();
});

test("an invitation link joins the workspace once accepted", async ({ page, browser }) => {
  // An owner (on another device) invites this user.
  const invitee = await signUp(page);
  const owner = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const ownerPage = await owner.newPage();
  await signUp(ownerPage);
  const org = await auth<{ id: string }>(ownerPage, "/organization/create", {
    name: "Invited Co",
    slug: `invited-${Date.now()}`,
  });
  const invitation = await auth<{ id: string }>(ownerPage, "/organization/invite-member", {
    email: invitee.email,
    role: "member",
    organizationId: org.id,
  });
  await owner.close();

  await page.goto(`/invitations/${invitation.id}`);
  // Opening the link only shows it: any app or page can open one.
  await expect(page.getByText("Join Invited Co to start collaborating.")).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByPlaceholder("What needs doing?")).toBeVisible();
  await page.getByRole("tab", { name: /Settings/ }).click();
  await expect(page.getByRole("radio", { name: "Invited Co" })).toBeChecked();
});

test("a session ended elsewhere sends the app back to sign in", async ({ page }) => {
  await signUp(page);
  // Sign out every session (as if from the web app's device list).
  await auth(page, "/revoke-sessions", {});
  await page.getByPlaceholder("What needs doing?").fill("After revocation");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Welcome back")).toBeVisible();
});

test("an app version the API no longer supports shows the update screen", async ({ page }) => {
  await signUp(page);
  // The API's answer to a build older than MINIMUM_CLIENT_VERSION.
  await page.route("**/rpc/**", (route) =>
    route.fulfill({
      status: 426,
      contentType: "application/json",
      body: JSON.stringify({
        json: { defined: true, code: "CLIENT_OUTDATED", status: 426, message: "", data: {} },
      }),
    }),
  );
  await page.reload();
  await expect(page.getByText("Update required")).toBeVisible();
});

test("a user with two-step verification signs in with an authenticator code", async ({ page }) => {
  const user = await signUp(page);
  // Turn it on through the API (the web app's settings do this with the same calls).
  const { totpURI } = await auth<{ totpURI: string }>(page, "/two-factor/enable", {
    password: user.password,
  });
  const secret = new URL(totpURI).searchParams.get("secret") as string;
  await auth(page, "/two-factor/verify-totp", { code: totp(secret) });
  await page.getByRole("tab", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Two-step verification")).toBeVisible();
  await page.getByLabel("Verification code").fill("000000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Verification code").fill(totp(secret));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByPlaceholder("What needs doing?")).toBeVisible();
});
