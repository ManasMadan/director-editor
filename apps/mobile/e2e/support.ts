/** Helpers for the app's end-to-end tests: users, emailed codes (Mailpit), per-test IPs. */
import { randomInt, randomUUID } from "node:crypto";
import { test as base, expect, type Page } from "@playwright/test";

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:58025";
const randomIp = () => `10.${randomInt(250)}.${randomInt(250)}.${randomInt(1, 250)}`;

/** Each test comes from its own address, so per-IP auth limits never collide. */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    await use({ ...extraHTTPHeaders, "x-forwarded-for": randomIp() });
  },
});
export { expect };

export type User = { name: string; email: string; password: string };

export const newUser = (): User => ({
  name: `Mobile ${randomUUID().slice(0, 8)}`,
  email: `mobile-${randomUUID()}@example.com`,
  password: `pw-${randomUUID()}`,
});

/** The 6-digit code in the newest email to `to` sent after `after`. */
export async function nextCode(to: string, after = new Date(0)) {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
        ).then((r) => r.json() as Promise<{ messages?: { ID: string; Created: string }[] }>);
        const latest = search.messages?.find((m) => new Date(m.Created) > after);
        if (!latest) {
          return false;
        }
        const message = await fetch(`${MAILPIT}/api/v1/message/${latest.ID}`).then(
          (r) => r.json() as Promise<{ Text: string }>,
        );
        code = /\b(\d{6})\b/.exec(message.Text)?.[1];
        return Boolean(code);
      },
      { timeout: 20_000, message: `a code emailed to ${to}` },
    )
    .toBe(true);
  return code as string;
}

export async function signUp(page: Page, user: User = newUser()) {
  const sent = new Date();
  await page.goto("/sign-up");
  await page.getByLabel("Full name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  await page.getByLabel("Verification code").fill(await nextCode(user.email, sent));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByPlaceholder("What needs doing?")).toBeVisible();
  return user;
}

/**
 * A passkey authenticator built into the browser (Chrome's virtual one), which answers
 * every prompt as if the person had confirmed it.
 */
export async function addPasskeyAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}
