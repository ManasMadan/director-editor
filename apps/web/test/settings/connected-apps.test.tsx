import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ConnectedAppsCard } from "@/modules/settings/components/connected-apps-card";
import { renderPage } from "../render";
import { currentSession, signOut, signUp } from "../users";

/** An app the user approved over OAuth in their active workspace (what consent records). */
async function connect(userId: string, name: string | null, options: { used?: boolean } = {}) {
  const session = await currentSession();
  const workspace = String(session.session.activeOrganizationId);
  const clientId = `client-${crypto.randomUUID()}`;
  await commands.sql(
    `INSERT INTO auth.oauth_client (client_id, name, scopes, contacts, redirect_uris, post_logout_redirect_uris, grant_types, response_types)
     VALUES ($1, $2, '{}', '{}', '{http://127.0.0.1/callback}', '{}', '{authorization_code}', '{code}')`,
    [clientId, name],
  );
  await commands.sql(
    `INSERT INTO auth.oauth_consent (client_id, user_id, reference_id, resources, requested_user_info_claims, scopes, updated_at)
     VALUES ($1, $2, $3, '{}', '{}', '{openid}', now())`,
    [clientId, userId, workspace],
  );
  if (options.used) {
    await commands.sql(
      `INSERT INTO auth.oauth_refresh_token (token, client_id, user_id, reference_id, resources, requested_user_info_claims, scopes, expires_at, created_at)
       VALUES ($1, $2, $3, $4, '{}', '{}', '{openid}', now() + interval '30 days', now() - interval '2 hours')`,
      [crypto.randomUUID(), clientId, userId, workspace],
    );
  }
}

describe("connected apps", () => {
  it("says when none are connected", async () => {
    await signUp();
    const page = await renderPage(<ConnectedAppsCard />, { url: "/settings/security" });
    await expect.element(page.getByText("No apps are connected.")).toBeVisible();
  });

  it("lists each app with its workspace and last use, and disconnects one", async () => {
    const user = await signUp();
    await connect(user.id, "Claude", { used: true });
    await connect(user.id, null);
    const page = await renderPage(<ConnectedAppsCard />, { url: "/settings/security" });
    await expect.element(page.getByText("Claude", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Unnamed app")).toBeVisible();
    await expect.element(page.getByText("last active 2 hours ago", { exact: false })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Disconnect: Claude" }));
    await expect.element(page.getByText("Claude was disconnected")).toBeVisible();
    await expect.poll(() => page.getByText("Claude", { exact: true }).query()).toBeNull();
  });

  it("says so when an app can't be disconnected", async () => {
    const user = await signUp();
    await connect(user.id, "Gone app");
    const page = await renderPage(<ConnectedAppsCard />, { url: "/settings/security" });
    await expect.element(page.getByText("Gone app", { exact: true })).toBeVisible();
    // Signed out on another device meanwhile.
    await signOut();
    await userEvent.click(page.getByRole("button", { name: "Disconnect: Gone app" }));
    await expect.element(page.getByText("Please sign in to continue.")).toBeVisible();
  });
});
