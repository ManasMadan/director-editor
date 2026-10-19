/**
 * The settings on the demo (the shared account and every demo guest): what it can't
 * change is said up front and never offered, rather than refused after it's tried (a
 * picture uploaded, then turned down). Its language and time zone are its own.
 */
import { describe, expect, it } from "vitest";
import { authClient } from "@/lib/auth-client";
import { ProfileSettingsPage, SecuritySettingsPage } from "@/modules/settings";
import { cleanup, renderPage } from "../render";
import { auth, currentSession, signUp } from "../users";

const LOCKED =
  "This is the demo, so its name, picture, email and security can't be changed. Create your own account to change them.";

describe("the demo's settings", () => {
  it("says what it can't change, and offers only its language and time zone", async () => {
    await auth("/sign-in/guest", { timezone: "UTC" });
    expect((await currentSession()).user.demo).toBe(true);

    const profile = await renderPage(<ProfileSettingsPage />, { url: "/settings" });
    await expect.element(profile.getByText(LOCKED)).toBeVisible();
    await expect.element(profile.getByLabelText("Name")).toBeDisabled();
    await expect.element(profile.getByLabelText("Time zone")).toBeEnabled();
    expect(profile.getByText("Profile picture").elements()).toHaveLength(0);
    expect(profile.getByRole("button", { name: "Upload a picture" }).elements()).toHaveLength(0);
    expect(profile.getByText("Current email", { exact: false }).elements()).toHaveLength(0);

    cleanup();
    const security = await renderPage(<SecuritySettingsPage />, { url: "/settings/security" });
    await expect.element(security.getByText(LOCKED)).toBeVisible();
    await expect.element(security.getByText("Signed-in devices", { exact: true })).toBeVisible();
    for (const title of ["Two-step verification", "Passkeys", "Password", "Delete account"]) {
      expect(security.getByText(title, { exact: true }).elements(), title).toHaveLength(0);
    }
  });

  it("offers nothing it might have to take back while it isn't known whose they are", async () => {
    await signUp();
    const session = authClient.$store.atoms.session as unknown as {
      get(): object;
      set(value: object): void;
    };
    // The session is read again (a refresh): it could still turn out to be the demo's.
    const pending = () => session.set({ ...session.get(), isPending: true });

    const profile = await renderPage(<ProfileSettingsPage />, { url: "/settings" });
    const email = profile.getByRole("button", { name: "Change email" });
    await expect.element(email).toBeVisible();
    pending();
    await expect.element(email).not.toBeInTheDocument();
    await expect.element(profile.getByLabelText("Name")).toBeDisabled();
    expect(profile.getByText(LOCKED).query()).toBeNull();
    authClient.$store.notify("$sessionSignal");
    await expect.element(email).toBeVisible();
    cleanup();

    const security = await renderPage(<SecuritySettingsPage />, { url: "/settings/security" });
    const remove = security.getByText("Delete account", { exact: true });
    await expect.element(remove).toBeVisible();
    pending();
    await expect.element(remove).not.toBeInTheDocument();
    expect(security.getByText(LOCKED).query()).toBeNull();
    await expect.element(security.getByText("Signed-in devices", { exact: true })).toBeVisible();
    authClient.$store.notify("$sessionSignal");
    await expect.element(remove).toBeVisible();
  });
});
