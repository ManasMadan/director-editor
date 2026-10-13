/** The security settings: devices, two-step verification, password, account deletion. */
import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { SecuritySettingsPage } from "@/modules/settings";
import { DeleteAccountCard } from "@/modules/settings/components/delete-account-card";
import { PasswordCard } from "@/modules/settings/components/password-card";
import { SessionsCard } from "@/modules/settings/components/sessions-card";
import { TwoFactorCard } from "@/modules/settings/components/two-factor-card";
import { cleanup, currentUrl, renderPage, router } from "../render";
import { auth, signOut, signUp } from "../users";

describe("the security page", () => {
  it("shows every security section", async () => {
    await signUp();
    const page = await renderPage(<SecuritySettingsPage />, { url: "/settings/security" });
    for (const title of [
      "Signed-in devices",
      "Two-step verification",
      "Passkeys",
      "Phone number",
      "Connected apps",
      "Password",
      "Delete account",
    ]) {
      await expect.element(page.getByText(title, { exact: true })).toBeVisible();
    }
  });
});

describe("signed-in devices", () => {
  it("names each device, marks this one, and signs others out", async () => {
    const user = await signUp();
    const agents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0",
      "Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:121.0) Gecko/20100101 Firefox/121.0",
      "curl/8.4.0",
      "",
    ];
    for (const userAgent of agents) {
      await commands.signInElsewhere(user.email, user.password, userAgent);
    }
    await commands.signInElsewhere(user.email, user.password, "curl/8.4.0", { withoutIp: true });

    const page = await renderPage(<SessionsCard />, { url: "/settings/security" });
    for (const device of [
      "Edge · Windows",
      "Firefox · Android",
      "Safari · iOS",
      "Chrome · Linux",
      "Firefox · macOS",
      "Unknown device",
    ]) {
      await expect.element(page.getByText(device)).toBeVisible();
    }
    await expect.element(page.getByText("This device")).toBeVisible();
    await expect.element(page.getByText("Browser", { exact: true }).first()).toBeVisible();
    await expect
      .element(page.getByText(/^Last active .*\d+\.\d+\.\d+\.\d+$/).first())
      .toBeVisible();

    const signOutButtons = page.getByRole("button", { name: "Sign out", exact: true });
    await expect.poll(() => signOutButtons.elements().length).toBe(8);
    await userEvent.click(signOutButtons.first());
    await expect.element(page.getByText("Signed out")).toBeVisible();
    await expect.poll(() => signOutButtons.elements().length).toBe(7);

    await userEvent.click(page.getByRole("button", { name: "Sign out of all other devices" }));
    await expect.poll(() => signOutButtons.elements().length).toBe(0);
    expect(page.getByRole("button", { name: "Sign out of all other devices" }).query()).toBeNull();
  });

  it("says so when signing a device out fails", async () => {
    const user = await signUp();
    await commands.signInElsewhere(user.email, user.password, "curl/8.4.0");
    const page = await renderPage(<SessionsCard />, { url: "/settings/security" });
    const other = page.getByRole("button", { name: "Sign out", exact: true }).first();
    await expect.element(other).toBeVisible();
    await signOut();
    await userEvent.click(other);
    await expect.element(page.getByText("Something went wrong. Please try again.")).toBeVisible();
  });

  it("asks for a new sign-in once the session is too old to list devices", async () => {
    await signUp();
    await commands.ageSession();
    const page = await renderPage(<SessionsCard />, { url: "/settings/security" });
    await expect.element(page.getByText("Confirm it's you")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Sign in again" }));
    await expect.poll(currentUrl).toBe("/sign-in?next=%2Fsettings%2Fsecurity");
    // Signed out, so the next sign-in starts fresh.
    const session = await fetch("/api/auth/get-session").then((response) => response.json());
    expect(session).toBeNull();
  });

  it("says why the devices can't be listed", async () => {
    await signUp();
    await commands.failRequests("/api/auth/list-sessions");
    const page = await renderPage(<SessionsCard />, { url: "/settings/security" });
    await expect.element(page.getByText("Something went wrong. Please try again.")).toBeVisible();
    expect(page.getByText("Confirm it's you").query()).toBeNull();
  });

  it("leaves out the address of a device that didn't record one", async () => {
    await signUp();
    await commands.editSession({ ipAddress: null });
    const page = await renderPage(<SessionsCard />, { url: "/settings/security" });
    await expect.element(page.getByText("This device")).toBeVisible();
    await expect.element(page.getByText(/^Last active [^·]+$/)).toBeVisible();
  });
});

describe("two-step verification", () => {
  it("turns on after scanning and confirming a code, and off with the password", async () => {
    const user = await signUp();
    const page = await renderPage(<TwoFactorCard />, { url: "/settings/security" });
    const password = page.getByLabelText("Confirm with your password");

    await userEvent.fill(password, "not-the-password");
    await userEvent.click(page.getByRole("button", { name: "Turn on" }));
    await expect.element(page.getByText("That password is wrong.")).toBeVisible();

    await userEvent.fill(password, user.password);
    await userEvent.click(page.getByRole("button", { name: "Turn on" }));
    const secret = page.getByTestId("totp-secret");
    await expect.element(secret).toBeVisible();
    expect(secret.element().textContent).toMatch(/^[A-Z2-7]+=*$/);
    expect(document.querySelector("svg[aria-label='Two-step verification']")).not.toBeNull();
    // Ten backup codes, in a list of their own.
    expect(document.querySelectorAll("ul.font-mono li")).toHaveLength(10);

    const right = await commands.totp(secret.element().textContent ?? "");
    await userEvent.fill(
      page.getByLabelText("Verification code"),
      right === "123456" ? "654321" : "123456",
    );
    await userEvent.click(page.getByRole("button", { name: "Turn on" }));
    await expect.element(page.getByText("That code is wrong.")).toBeVisible();
    await expect.element(page.getByLabelText("Verification code")).toHaveValue("");

    await userEvent.fill(
      page.getByLabelText("Verification code"),
      await commands.totp(secret.element().textContent ?? ""),
    );
    await userEvent.click(page.getByRole("button", { name: "Turn on" }));
    await expect.element(page.getByText("Two-step verification is on").first()).toBeVisible();

    await userEvent.fill(page.getByLabelText("Confirm with your password"), "not-the-password");
    await userEvent.click(page.getByRole("button", { name: "Turn off" }));
    await expect.element(page.getByText("That password is wrong.")).toBeVisible();
    await userEvent.fill(page.getByLabelText("Confirm with your password"), user.password);
    await userEvent.click(page.getByRole("button", { name: "Turn off" }));
    await expect.element(page.getByRole("button", { name: "Turn on" })).toBeVisible();
  });
});

describe("the password", () => {
  it("shows a refusal about the new password on it", async () => {
    const user = await signUp();
    // Answered as the API refuses a breached password: only production's API checks one
    // (Have I Been Pwned); the API's own suite covers the check against a stand-in.
    await commands.failRequests("/api/auth/change-password", {
      status: 400,
      body: { code: "PASSWORD_COMPROMISED", message: "compromised" },
    });
    const page = await renderPage(<PasswordCard />, { url: "/settings/security" });
    await userEvent.fill(page.getByLabelText("Current password"), user.password);
    await userEvent.fill(page.getByLabelText("New password"), `pw-${crypto.randomUUID()}`);
    await userEvent.click(page.getByRole("button", { name: "Change password" }));
    await expect
      .element(page.getByText("This password appeared in a data breach. Choose a different one."))
      .toBeVisible();
  });

  it("is changed after checking the current one and the new one", async () => {
    const user = await signUp();
    const page = await renderPage(<PasswordCard />, { url: "/settings/security" });
    const current = page.getByLabelText("Current password");
    const next = page.getByLabelText("New password");
    const change = page.getByRole("button", { name: "Change password" });

    await userEvent.fill(current, "not-the-password");
    await userEvent.fill(next, `pw-${crypto.randomUUID()}`);
    await userEvent.click(change);
    await expect.element(page.getByText("That password is wrong.")).toBeVisible();

    await userEvent.fill(current, user.password);
    const password = `pw-${crypto.randomUUID()}`;
    await userEvent.fill(next, password);
    await userEvent.click(change);
    await expect.element(page.getByText("Password changed")).toBeVisible();
    await expect.element(current).toHaveValue("");
    await signOut();
    await expect(auth("/sign-in/email", { email: user.email, password })).resolves.toBeTruthy();
  });
});

describe("deleting the account", () => {
  it("needs the password, then leaves for the home page", async () => {
    const user = await signUp();
    const page = await renderPage(<DeleteAccountCard />, { url: "/settings/security" });
    const password = page.getByLabelText("Enter your password to confirm");
    await userEvent.fill(password, "not-the-password");
    await userEvent.click(page.getByRole("button", { name: "Delete my account" }));
    await expect.element(page.getByText("That password is wrong.")).toBeVisible();

    await userEvent.fill(password, user.password);
    await userEvent.click(page.getByRole("button", { name: "Delete my account" }));
    await expect.element(page.getByText("Your account was deleted")).toBeVisible();
    await expect.poll(currentUrl).toBe("/");
    expect(router.refreshes).toBe(1);
    cleanup();
    await expect(
      auth("/sign-in/email", { email: user.email, password: user.password }),
    ).rejects.toThrow(/401/);
  });
});
