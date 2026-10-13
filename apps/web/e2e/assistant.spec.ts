/**
 * The assistant, through the whole stack: web → API → Python service (FastAPI) → its
 * worker (indexing, via the ai-ingest queue) → pgvector search → streamed answer.
 * Runs with AI_MODEL=local:extractive (answers by quoting the best passage, no model
 * provider needed) and hashing embeddings.
 */
import type { Browser, Page } from "@playwright/test";
import { createWorkspace, expect, inviteAndAccept, newDevice, signUp, test } from "./support";

async function addDocument(page: Page, title: string, content: string) {
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Text").fill(content);
  await page.getByRole("button", { name: "Add document" }).click();
  await expect(page.getByText("Document added. It will be ready in a moment.")).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row.getByText("Ready")).toBeVisible({ timeout: 20_000 });
  return row;
}

async function ask(page: Page, question: string) {
  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Ask" }).click();
  return page.getByTestId("answer");
}

async function someone(browser: Browser) {
  const device = await newDevice(browser);
  return { page: device.page, user: await signUp(device.page) };
}

test("add a document and get an answer from it, with its source", async ({ page }) => {
  await signUp(page);
  await createWorkspace(page, "Helpdesk");
  await page.goto("/assistant");
  await expect(page.getByRole("heading", { name: "Assistant" })).toBeVisible();
  await expect(page.getByText("No documents yet.")).toBeVisible();

  const row = await addDocument(
    page,
    "Refund policy",
    "Refunds take five business days to reach your card.\n\nWe ship worldwide from Lisbon.",
  );
  await expect(row.getByText("1 passage")).toBeVisible();
  // The summary follows indexing (the local summarizer keeps the opening sentence).
  await expect(row.getByText("Refunds take five business days to reach your card.")).toBeVisible({
    timeout: 20_000,
  });

  const answer = await ask(page, "How long do refunds take?");
  await expect(answer).toContainText("Refunds take five business days", { timeout: 20_000 });
  await expect(page.getByText("From: Refund policy")).toBeVisible();
});

test("says so when the documents don't have the answer", async ({ page }) => {
  await signUp(page);
  await createWorkspace(page, "Empty");
  await page.goto("/assistant");
  const answer = await ask(page, "What is the meaning of life?");
  await expect(answer).toHaveText("I couldn't find that in the workspace's documents.", {
    timeout: 20_000,
  });
});

test("each workspace answers only from its own documents", async ({ page }) => {
  await signUp(page);
  await createWorkspace(page, "First");
  await page.goto("/assistant");
  await addDocument(page, "Secret recipe", "The secret ingredient is cardamom.");

  await createWorkspace(page, "Second");
  await page.goto("/assistant");
  await expect(page.getByText("No documents yet.")).toBeVisible();
  const answer = await ask(page, "What is the secret ingredient?");
  await expect(answer).toHaveText("I couldn't find that in the workspace's documents.", {
    timeout: 20_000,
  });
});

test("members remove their own documents; admins remove any", async ({ page, browser }) => {
  await signUp(page);
  await createWorkspace(page, "Shared");
  const member = await someone(browser);
  await inviteAndAccept(page, member);

  await page.goto("/assistant");
  const ownersDocument = await addDocument(page, "Owner notes", "Written by the owner.");
  await member.page.goto("/assistant");
  const membersDocument = await addDocument(member.page, "Member notes", "Written by a member.");

  // The member can't remove the owner's document, only their own.
  await expect(
    member.page.getByRole("listitem").filter({ hasText: "Owner notes" }).getByRole("button"),
  ).toHaveCount(0);
  await membersDocument.getByRole("button", { name: "Remove: Member notes" }).click();
  await expect(member.page.getByText("Document removed")).toBeVisible();
  await expect(member.page.getByRole("listitem").filter({ hasText: "Member notes" })).toHaveCount(
    0,
  );

  // The owner (an admin) can remove anyone's, including the member's.
  await addDocument(member.page, "More member notes", "Also by the member.");
  await page.reload();
  await expect(ownersDocument.getByRole("button", { name: "Remove: Owner notes" })).toBeVisible();
  await page.getByRole("button", { name: "Remove: More member notes" }).click();
  await expect(page.getByText("Document removed")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "More member notes" })).toHaveCount(0);
});

test("an empty question isn't sent", async ({ page }) => {
  await signUp(page);
  await page.goto("/assistant");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/ai/ask")) {
      requests.push(request.url());
    }
  });
  await page.getByRole("button", { name: "Ask" }).click();
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
  await expect(page.getByTestId("answer")).toHaveCount(0);
});

test("the assistant is in the account menu", async ({ page }) => {
  const user = await signUp(page);
  await page.getByRole("button", { name: user.name }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();
  await expect(page).toHaveURL(/\/assistant$/);
});
