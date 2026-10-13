/** The profile settings: name, language and time zone, and the sign-in email. */
import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ProfileSettingsPage } from "@/modules/settings";
import { EmailCard } from "@/modules/settings/components/email-card";
import { ProfileCard } from "@/modules/settings/components/profile-card";
import { renderPage, router } from "../render";
import { currentSession, rateLimit, signOut, signUp, takeOtp, type User } from "../users";

const other = (code: string) => (code === "000000" ? "111111" : "000000");

describe("the profile page", () => {
  it("shows the profile, picture and email sections", async () => {
    await signUp();
    const page = await renderPage(<ProfileSettingsPage />, { url: "/settings" });
    await expect.element(page.getByLabelText("Name")).toBeVisible();
    await expect.element(page.getByText("Profile picture")).toBeVisible();
    await expect.element(page.getByText("Current email", { exact: false })).toBeVisible();
  });
});

describe("the profile", () => {
  it("saves the name, language and time zone, and re-renders in them", async () => {
    await signUp();
    const page = await renderPage(<ProfileCard />, { url: "/settings" });
    const save = page.getByRole("button", { name: "Save" });
    const name = page.getByLabelText("Name");
    await expect.element(name).toBeVisible();
    await expect.element(save).toBeDisabled();

    await userEvent.fill(name, " ");
    await userEvent.click(save);
    await expect.element(page.getByText("Enter your name")).toBeVisible();

    await userEvent.fill(name, "Ada Lovelace");
    await userEvent.click(page.getByLabelText("Language"));
    await userEvent.click(page.getByRole("option", { name: "español" }));
    await userEvent.selectOptions(page.getByLabelText("Time zone"), "Europe/Madrid");
    await userEvent.click(save);
    await expect.element(page.getByText("Profile saved")).toBeVisible();
    expect(document.cookie).toContain("locale=es");
    expect(document.cookie).toContain("tz=Europe%2FMadrid");
    expect(router.refreshes).toBe(1);
    await expect.element(save).toBeDisabled();

    const me = await currentSession();
    expect(me.user).toMatchObject({
      name: "Ada Lovelace",
      locale: "es",
      timezone: "Europe/Madrid",
    });
  });

  it("shows English for a language the app no longer has", async () => {
    await signUp();
    await commands.editSession({}, { locale: "xx" });
    const page = await renderPage(<ProfileCard />, { url: "/settings" });
    await expect.element(page.getByLabelText("Name")).toBeVisible();
    await expect.element(page.getByText("English", { exact: true })).toBeVisible();
  });

  it("says so when it can't be saved", async () => {
    await signUp();
    const page = await renderPage(<ProfileCard />, { url: "/settings" });
    await expect.element(page.getByLabelText("Name")).toBeVisible();
    await signOut();
    await userEvent.fill(page.getByLabelText("Name"), "Signed out meanwhile");
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await expect.element(page.getByText("Something went wrong. Please try again.")).toBeVisible();
  });
});

describe("changing the email", () => {
  async function start(user: User) {
    const page = await renderPage(<EmailCard />, { url: "/settings" });
    await expect.element(page.getByText(user.email, { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Change email" }));
    await expect.element(page.getByLabelText(`Code sent to ${user.email}`)).toBeVisible();
    return page;
  }

  it("takes a code from the current address, then one from the new one", async () => {
    const user = await signUp();
    const page = await start(user);
    const currentCode = await takeOtp(user.email);
    const newEmail = `web-${crypto.randomUUID()}@example.com`;
    const send = page.getByRole("button", { name: "Send code to new email" });

    await userEvent.fill(page.getByLabelText(`Code sent to ${user.email}`), currentCode);
    await userEvent.fill(page.getByLabelText("New email"), user.email.toUpperCase());
    await userEvent.click(send);
    await expect.element(page.getByText("That's already your email.")).toBeVisible();

    await userEvent.fill(page.getByLabelText("New email"), newEmail);
    const code = page.getByLabelText(`Code sent to ${user.email}`);
    // A full one-time-code box takes no more digits: empty it first.
    await userEvent.clear(code);
    await userEvent.fill(code, other(currentCode));
    await expect.element(code).toHaveValue(other(currentCode));
    await userEvent.click(send);
    await expect.element(page.getByText("That code is wrong or has expired.")).toBeVisible();
    await expect.element(page.getByLabelText(`Code sent to ${user.email}`)).toHaveValue("");

    await userEvent.fill(page.getByLabelText(`Code sent to ${user.email}`), currentCode);
    await userEvent.click(send);
    const confirm = page.getByLabelText(`Code sent to ${newEmail}`);
    await expect.element(confirm).toBeVisible();
    const newCode = await takeOtp(newEmail);

    await userEvent.fill(confirm, other(newCode));
    await userEvent.click(page.getByRole("button", { name: "Change email" }));
    await expect.element(page.getByText("That code is wrong or has expired.")).toBeVisible();
    await expect.element(confirm).toHaveValue("");

    await userEvent.fill(confirm, newCode);
    await userEvent.click(page.getByRole("button", { name: "Change email" }));
    await expect.element(page.getByText(`Email changed to ${newEmail}`)).toBeVisible();
    await expect.element(page.getByText(newEmail, { exact: true })).toBeVisible();
  });

  it("can't be started while signed out", async () => {
    const page = await renderPage(<EmailCard />, { url: "/settings" });
    await expect.element(page.getByRole("button", { name: "Change email" })).toBeDisabled();
  });

  it("says so when no code can be sent now", async () => {
    const user = await signUp();
    await rateLimit("/email-otp/send-verification-otp", {
      email: user.email,
      type: "email-verification",
    });
    const page = await renderPage(<EmailCard />, { url: "/settings" });
    await userEvent.click(page.getByRole("button", { name: "Change email" }));
    await expect
      .element(page.getByText("Too many attempts. Wait a minute and try again."))
      .toBeVisible();
  });
});
