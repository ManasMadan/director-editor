/**
 * Clicking a web push notification, through the real service worker (public/sw.js) in a
 * real browser. Headless Chromium can't show a notification for anyone to click, so the
 * worker receives the `notificationclick` event its click would fire, carrying what
 * push.spec.ts checks it shows. Focusing and opening windows need the click's user
 * activation, which no script can give, so those two are recorded instead; finding the
 * site's window and navigating it are the browser's own.
 */
import type { Page, Worker } from "@playwright/test";
import { expect, test } from "./support";

type Scope = {
  opened: string[];
  click: (link: string) => Promise<boolean>;
  clients: { openWindow: (url: string) => Promise<null> };
};

/** A page of the site under the worker's control, and the worker, set up to be clicked. */
async function controlled(page: Page) {
  await page.goto("/privacy");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const context = page.context();
  const worker: Worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(() => {
    const scope = self as unknown as Scope;
    const WindowClient = Reflect.get(self, "WindowClient") as { prototype: object };
    Reflect.set(WindowClient.prototype, "focus", function focus(this: object) {
      return Promise.resolve(this);
    });
    scope.opened = [];
    scope.clients.openWindow = async (url) => {
      scope.opened.push(url);
      return null;
    };
    // The event a click on a notification with this link fires; whether it was closed,
    // once whatever it waits for is done.
    scope.click = (link) => {
      let closed = false;
      let pending: Promise<unknown> = Promise.resolve();
      const event = new Event("notificationclick");
      Object.defineProperties(event, {
        notification: { value: { data: { link }, close: () => (closed = true) } },
        waitUntil: { value: (promise: Promise<unknown>) => (pending = promise) },
      });
      self.dispatchEvent(event);
      return pending.then(() => closed);
    };
  });
  return worker;
}

test("a notification's click takes the site's open window to its link", async ({ page }) => {
  const worker = await controlled(page);
  expect(await worker.evaluate(() => (self as unknown as Scope).click("/terms"))).toBe(true);
  await expect(page).toHaveURL(/\/terms$/);
  expect(await worker.evaluate(() => (self as unknown as Scope).opened)).toEqual([]);
});

test("a notification's click opens the site when no window of it is open", async ({
  page,
  context,
}) => {
  const worker = await controlled(page);
  const origin = new URL(page.url()).origin;
  // Keep the browser open on another page, so only the site's window goes.
  await (await context.newPage()).goto("about:blank");
  await page.close();
  expect(await worker.evaluate(() => (self as unknown as Scope).click("/terms"))).toBe(true);
  expect(await worker.evaluate(() => (self as unknown as Scope).opened)).toEqual([
    `${origin}/terms`,
  ]);
});

test("a notification linking to another site only closes", async ({ page }) => {
  const worker = await controlled(page);
  const before = page.url();
  for (const link of ["https://phish.example/login", "//phish.example/login"]) {
    expect(await worker.evaluate((l) => (self as unknown as Scope).click(l), link)).toBe(true);
  }
  expect(await worker.evaluate(() => (self as unknown as Scope).opened)).toEqual([]);
  expect(page.url()).toBe(before);
});
