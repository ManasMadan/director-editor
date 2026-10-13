/**
 * Adding a phone number for security texts. Locally, texts are delivered to Mailpit as
 * emails to <digits>@sms.test (SMS_PROVIDER=email), so the codes are read from there.
 */
import type { Page } from "@playwright/test";
import { ageSession, expect, mailbox, signUp, test } from "./support";

const THREE_HOURS = 3 * 60 * 60 * 1000;
const newPhone = () => `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const texts = (phone: string) => mailbox(`${phone.slice(1)}@sms.test`);

function phoneCard(page: Page) {
  return page.locator("[data-slot=card]", { hasText: "Phone number" });
}

async function requestCode(page: Page, typed: string) {
  const card = phoneCard(page);
  await card.getByRole("button", { name: /Add a phone number|Change number/ }).click();
  await card.getByLabel("Phone number").fill(typed);
  await card.getByRole("button", { name: "Text me a code" }).click();
}

test("add a phone number with a texted code; the account is alerted", async ({ page }) => {
  const user = await signUp(page);
  const email = await mailbox(user.email);
  await page.goto("/settings/security");
  const card = phoneCard(page);
  await expect(card.getByText("No phone number yet.")).toBeVisible();

  const phone = newPhone();
  const inbox = await texts(phone);
  // Typed the way people write numbers; stored and shown as E.164.
  await requestCode(
    page,
    `${phone.slice(0, 2)} ${phone.slice(2, 5)}-${phone.slice(5, 8)}-${phone.slice(8)}`,
  );
  await expect(card.getByText(`We texted a code to ${phone}.`)).toBeVisible();
  const text = await inbox.next();
  expect(text.Text).toMatch(/^\d{6} is your Boilerplate verification code/);
  const code = /^(\d{6})/.exec(text.Text)?.[1] as string;

  await card.getByLabel("Code from the text").fill(code);
  await card.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Phone number saved")).toBeVisible();
  await expect(card.getByText(phone)).toBeVisible();

  expect((await email.next()).Subject).toBe("A phone number was added");
  expect((await inbox.next()).Text).toContain("this number was added to your account");

  // Still there after a reload.
  await page.reload();
  await expect(phoneCard(page).getByText(phone)).toBeVisible();
});

test("a wrong code is rejected and cleared; a new code can be sent", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings/security");
  const phone = newPhone();
  const inbox = await texts(phone);
  await requestCode(page, phone);
  const code = /^(\d{6})/.exec((await inbox.next()).Text)?.[1] as string;

  const card = phoneCard(page);
  const field = card.getByLabel("Code from the text");
  await field.fill(code === "000000" ? "111111" : "000000");
  await card.getByRole("button", { name: "Verify" }).click();
  await expect(card.getByText(/That code isn't right, or it expired/)).toBeVisible();
  await expect(field).toHaveValue("");

  await card.getByRole("button", { name: "Send a new code" }).click();
  const fresh = /^(\d{6})/.exec((await inbox.next()).Text)?.[1] as string;
  await field.fill(fresh);
  await card.getByRole("button", { name: "Verify" }).click();
  await expect(card.getByText(phone)).toBeVisible();
});

test("an invalid number is caught before anything is sent", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings/security");
  const card = phoneCard(page);
  await card.getByRole("button", { name: "Add a phone number" }).click();
  await card.getByLabel("Phone number").fill("4155550123");
  await card.getByRole("button", { name: "Text me a code" }).click();
  await expect(card.getByText(/Enter the number with its country code/)).toBeVisible();
  // Cancel goes back without a number.
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByText("No phone number yet.")).toBeVisible();
});

test("a number already on another account is refused once its code is entered", async ({
  page,
  browser,
}) => {
  await signUp(page);
  await page.goto("/settings/security");
  const phone = newPhone();
  const inbox = await texts(phone);
  await requestCode(page, phone);
  const code = /^(\d{6})/.exec((await inbox.next()).Text)?.[1] as string;
  await phoneCard(page).getByLabel("Code from the text").fill(code);
  await phoneCard(page).getByRole("button", { name: "Verify" }).click();
  await expect(phoneCard(page).getByText(phone)).toBeVisible();
  expect((await inbox.next()).Text).toContain("this number was added to your account");

  // Asking for a code says nothing about whose number it is: only proving the texts
  // arrive does, when the code is entered.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signUp(otherPage);
  await otherPage.goto("/settings/security");
  await requestCode(otherPage, phone);
  const otherCode = /^(\d{6})/.exec((await inbox.next()).Text)?.[1] as string;
  await phoneCard(otherPage).getByLabel("Code from the text").fill(otherCode);
  await phoneCard(otherPage).getByRole("button", { name: "Verify" }).click();
  await expect(otherPage.getByText("That number is already on an account.")).toBeVisible();
  await other.close();
});

test("remove the number; the removed number is told", async ({ page }) => {
  const user = await signUp(page);
  const email = await mailbox(user.email);
  await page.goto("/settings/security");
  const phone = newPhone();
  const inbox = await texts(phone);
  await requestCode(page, phone);
  const code = /^(\d{6})/.exec((await inbox.next()).Text)?.[1] as string;
  const card = phoneCard(page);
  await card.getByLabel("Code from the text").fill(code);
  await card.getByRole("button", { name: "Verify" }).click();
  await expect(card.getByText(phone)).toBeVisible();
  // The "added" alert, by text and by email.
  await inbox.next();
  expect((await email.next()).Subject).toBe("A phone number was added");

  await card.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Phone number removed")).toBeVisible();
  await expect(card.getByText("No phone number yet.")).toBeVisible();
  expect((await inbox.next()).Text).toContain("this number was removed from your account");
  expect((await email.next()).Subject).toBe("Your phone number was removed");
});

test("an old session is asked to sign in again before changing the number", async ({
  page,
  context,
}) => {
  await signUp(page);
  await ageSession(context, THREE_HOURS);
  await page.goto("/settings/security");
  await requestCode(page, newPhone());
  await expect(
    phoneCard(page).getByText("For your security, sign in again to see or change this."),
  ).toBeVisible();
});
