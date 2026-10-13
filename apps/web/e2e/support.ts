/**
 * Shared e2e helpers. Tests run against the real stack; emails are read back from Mailpit.
 *
 * Each test (and each extra "device") gets its own client IP through X-Forwarded-For, so
 * the per-IP auth rate limits never make parallel tests fail each other. This works
 * locally because every hop is on loopback, which the API trusts (TRUSTED_PROXIES).
 *
 * Where the API has Turnstile on (CI uses Cloudflare's always-pass test keys), pages get a
 * stand-in widget that hands over Cloudflare's dummy token at once, which those keys
 * accept: a sign-up then never waits on Cloudflare's real widget, which can hang on a CI
 * runner. captcha.spec.ts opts back into the real one with `realTurnstile`.
 */
import { randomInt, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import {
  type Browser,
  type BrowserContext,
  test as base,
  expect,
  type Page,
} from "@playwright/test";
import { todoIdSchema, userIdSchema } from "@repo/contracts/ids";
import { totp } from "@repo/testing/totp";
import { Redis } from "ioredis";
import { FAKE_TURNSTILE } from "../test/turnstile";

// Authenticator codes (RFC 6238), shared with the mobile suite.
export { totp };

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:58025";
/** The site's origin: E2E_BASE_URL, else WEB_URL (the root .env's, or the e2e run's). */
const site = process.env.E2E_BASE_URL ?? process.env.WEB_URL;
if (!site) {
  throw new Error("Set WEB_URL (the root .env has it) or E2E_BASE_URL.");
}
export const BASE_URL = site;

const randomIp = () => `10.${randomInt(250)}.${randomInt(250)}.${randomInt(1, 250)}`;

async function standInTurnstile(context: BrowserContext) {
  await context.route("https://challenges.cloudflare.com/turnstile/**", (route) =>
    route.fulfill({ contentType: "text/javascript", body: FAKE_TURNSTILE }),
  );
}

export const test = base.extend<{ realTurnstile: boolean }>({
  realTurnstile: [false, { option: true }],
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    await use({ ...extraHTTPHeaders, "x-forwarded-for": randomIp() });
  },
  context: async ({ context, realTurnstile }, use) => {
    if (!realTurnstile) {
      await standInTurnstile(context);
    }
    await use(context);
  },
});
export { expect };

/** A second browser (another device) for the same or another user. */
export async function newDevice(browser: Browser, options: { locale?: string } = {}) {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    locale: options.locale ?? "en-US",
    extraHTTPHeaders: { "x-forwarded-for": randomIp() },
  });
  await standInTurnstile(context);
  return { context, page: await context.newPage() };
}

export type User = { name: string; email: string; password: string };

export const newUser = (): User => ({
  name: `E2E ${randomUUID().slice(0, 8)}`,
  email: `e2e-${randomUUID()}@example.com`,
  // Random, so the breached-password check never rejects it.
  password: `pw-${randomUUID()}`,
});

// ---------------------------------------------------------------------------- email

interface MailSummary {
  ID: string;
  Subject: string;
}

async function messagesTo(to: string): Promise<MailSummary[]> {
  const response = await fetch(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  return ((await response.json()) as { messages?: MailSummary[] }).messages ?? [];
}

/**
 * A mailbox: remembers which emails it has already seen, so `next()` never returns an
 * old one. (By id, not count: Mailpit prunes old messages, so counts can go down.)
 */
export async function mailbox(to: string) {
  const seen = new Set((await messagesTo(to)).map((message) => message.ID));
  return {
    /** The next email to arrive (plain text, HTML and subject). */
    async next() {
      let latest: MailSummary | undefined;
      await expect
        .poll(
          async () => {
            latest = (await messagesTo(to)).find((message) => !seen.has(message.ID));
            return Boolean(latest);
          },
          { timeout: 20_000, message: `an email to ${to}` },
        )
        .toBe(true);
      const id = latest?.ID as string;
      seen.add(id);
      return (await fetch(`${MAILPIT}/api/v1/message/${id}`).then((r) => r.json())) as {
        Text: string;
        HTML: string;
        Subject: string;
      };
    },
    async nextCode() {
      const { Text } = await this.next();
      const code = /\b(\d{6})\b/.exec(Text)?.[1];
      expect(code, "a 6-digit code in the email").toBeDefined();
      return code as string;
    },
    async count() {
      return (await messagesTo(to)).length;
    },
  };
}

// ---------------------------------------------------------------------------- auth flows

export async function signUp(
  page: Page,
  user: User = newUser(),
  options: { expectUrl?: RegExp } = {},
) {
  const inbox = await mailbox(user.email);
  if (!/\/sign-up/.test(page.url())) {
    await page.goto("/sign-up");
  }
  await page.getByLabel("Full name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/verify-email/);
  await page.getByLabel("Verification code").fill(await inbox.nextCode());
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(options.expectUrl ?? /\/dashboard/);
  return user;
}

export async function signIn(page: Page, user: User, options: { expectUrl?: RegExp } = {}) {
  if (!/\/sign-in/.test(page.url())) {
    await page.goto("/sign-in");
  }
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("main").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(options.expectUrl ?? /\/dashboard/);
}

export async function signOut(page: Page, user: User) {
  await page.getByRole("button", { name: user.name }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${BASE_URL}/`);
}

/** Calls a better-auth endpoint as the page's signed-in user (for setup the UI doesn't offer yet). */
export async function authApi<T = unknown>(page: Page, path: string, body: unknown): Promise<T> {
  const response = await page.request.post(`/api/auth${path}`, {
    data: body,
    headers: { origin: BASE_URL },
  });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** Turns on two-step verification through settings; returns the secret and backup codes. */
export async function enableTwoFactor(page: Page, user: User) {
  await page.goto("/settings/security");
  const card = page.locator("[data-slot=card]", { hasText: "Two-step verification" });
  await card.getByLabel("Confirm with your password").fill(user.password);
  await card.getByRole("button", { name: "Turn on" }).click();
  const secret = (await card.getByTestId("totp-secret").textContent()) ?? "";
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  const backupCodes = await card.locator("ul li").allTextContents();
  expect(backupCodes).toHaveLength(10);
  await card.getByLabel("Verification code").fill(totp(secret));
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card.getByText("Two-step verification is on").first()).toBeVisible();
  return { secret, backupCodes };
}

// ---------------------------------------------------------------------------- passkeys

/**
 * A virtual platform authenticator (Chrome DevTools Protocol) that approves every prompt,
 * standing in for Touch ID / Windows Hello. `setPresence(false)` makes it refuse, the
 * same outcome as the user closing the browser's passkey dialog.
 */
export async function virtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    async credentials() {
      return (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
    },
    async clear() {
      await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    },
    async setVerified(isUserVerified: boolean) {
      await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified });
    },
  };
}

// ---------------------------------------------------------------------------- accessibility

/**
 * Fails on any WCAG 2.2 A/AA violation on the current page. Transitions finish first: axe
 * measures colours as drawn, so a button fading in would read as low contrast.
 * Endless animations (spinners) are left running, since they never finish.
 */
export async function expectAccessible(page: Page) {
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = results.violations.map(
    (v) =>
      `${v.id}: ${v.help} → ${v.nodes.map((n) => `${n.target.join(" ")} ${n.failureSummary ?? ""}`).join(" | ")}`,
  );
  expect(violations).toEqual([]);
}

// ---------------------------------------------------------------------------- simulated time

/**
 * The stack's Redis, where better-auth keeps sessions and one-time codes. Tests reach
 * in to simulate time passing (an old session, an expired code) instead of waiting.
 */
let redis: Redis | undefined;
const authStore = () => {
  redis ??= new Redis(process.env.REDIS_URL ?? "redis://localhost:56379", { lazyConnect: false });
  return redis;
};
test.afterAll(async () => {
  await redis?.quit();
  redis = undefined;
});

/** Makes the context's session look as if it was signed in `ms` ago. */
export async function ageSession(context: BrowserContext, ms: number) {
  const cookie = (await context.cookies()).find((c) =>
    c.name.endsWith("better-auth.session_token"),
  );
  expect(cookie, "a session cookie").toBeDefined();
  const key = `auth:${decodeURIComponent(cookie?.value ?? "").split(".")[0]}`;
  const stored = JSON.parse((await authStore().get(key)) ?? "null") as {
    session: { createdAt: string };
  } | null;
  expect(stored, `a session at ${key}`).not.toBeNull();
  if (!stored) {
    return;
  }
  stored.session.createdAt = new Date(Date.now() - ms).toISOString();
  await authStore().set(key, JSON.stringify(stored), "KEEPTTL");
}

/** Moves every pending one-time code for `email` past its expiry. */
export async function expireCodes(email: string) {
  let expired = 0;
  for (const key of await authStore().keys("auth:verification:*")) {
    const raw = await authStore().get(key);
    if (!raw?.includes(email)) {
      continue;
    }
    const stored = JSON.parse(raw) as { expiresAt: string };
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    await authStore().set(key, JSON.stringify(stored), "KEEPTTL");
    expired += 1;
  }
  expect(expired, `a pending code for ${email}`).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------- workspaces

/** Creates a team workspace through the header switcher and switches to it. */
export async function createWorkspace(page: Page, name: string) {
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("menuitem", { name: "New workspace" }).click();
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText("Workspace created")).toBeVisible();
  await expect(page.getByRole("button", { name: "Workspace", exact: true })).toContainText(name);
}

/** Invites `invitee` to the active workspace (Members page) and has them accept by email. */
export async function inviteAndAccept(
  owner: Page,
  invitee: { page: Page; user: User },
  role = "Member",
) {
  const inbox = await mailbox(invitee.user.email);
  await owner.goto("/settings/members");
  await owner.getByLabel("Email").fill(invitee.user.email);
  if (role !== "Member") {
    await owner.getByRole("combobox", { name: "Role" }).click();
    await owner.getByRole("option", { name: role }).click();
  }
  await owner.getByRole("button", { name: "Send invitation" }).click();
  await expect(owner.getByText(`Invitation sent to ${invitee.user.email}`)).toBeVisible();
  const { Text } = await inbox.next();
  const link = /(https?:\/\/\S+\/invitations\/[0-9a-f-]{36})/.exec(Text)?.[1];
  expect(link, "an invitation link").toBeDefined();
  await invitee.page.goto(new URL(link as string).pathname);
  await invitee.page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitee.page).toHaveURL(/\/dashboard/);
}

/**
 * Waits until the page has rendered its data: no loading skeletons left. (Not
 * "networkidle": the realtime stream keeps a request open for as long as the page is.)
 */
export async function settled(page: Page) {
  await expect(page.locator("[data-slot=skeleton]")).toHaveCount(0);
}

// ---------------------------------------------------------------------------- notifications

/** Queues a reminder for the page's user, the way a producer service would. */
export async function sendReminder(page: Page, title: string) {
  const { createProducer } = await import("@repo/jobs");
  const me = (await (await page.request.get("/api/v1/me")).json()) as { id: string };
  const producer = createProducer("notifications-bulk", authStore());
  await producer.add(
    "send",
    {
      template: "todo.reminder",
      to: { userId: userIdSchema.parse(me.id) },
      data: { todoId: todoIdSchema.parse(randomUUID()), title },
    },
    { jobId: randomUUID() },
  );
  await producer.close();
}

// ---------------------------------------------------------------------------- billing

/**
 * Puts the active workspace on Pro through the (fake) Stripe checkout, as a customer
 * would: billing settings → checkout → pay → back, until the plan shows.
 */
export async function upgrade(page: Page, interval: "monthly" | "yearly" = "monthly") {
  await page.goto("/settings/billing");
  await page.getByRole("button", { name: `Upgrade, billed ${interval}` }).click();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/billing\?checkout=done/);
  await expect(page.getByText("Pro", { exact: true })).toBeVisible({ timeout: 20_000 });
}
