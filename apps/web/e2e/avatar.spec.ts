/**
 * Profile pictures: uploaded straight to object storage, checked by the worker (virus
 * scan, type from the bytes, re-encoded without metadata) and only then shown. Needs
 * files on (S3_BUCKET) with RustFS and ClamAV running (docker compose --profile files).
 */
import type { Page } from "@playwright/test";
import sharp from "sharp";
import { expect, signUp, test } from "./support";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

function photo(color: string) {
  return sharp({ create: { width: 900, height: 600, channels: 3, background: color } })
    .jpeg()
    .withExif({ IFD0: { Artist: "Location Leak" } })
    .toBuffer();
}

function card(page: Page) {
  return page.locator("[data-slot=card]", { hasText: "Profile picture" });
}

async function choose(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await card(page).locator("input[type=file]").setInputFiles({ name, mimeType, buffer });
}

/** The picture shown in the card, once loaded: its natural size. */
async function shownPicture(page: Page) {
  const image = card(page).locator("img");
  await expect(image).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
  return image.evaluate((img: HTMLImageElement) => ({
    src: img.getAttribute("src"),
    width: img.naturalWidth,
    height: img.naturalHeight,
  }));
}

test("upload a profile picture: checked, cropped square, shown everywhere", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings");
  await expect(card(page).getByRole("button", { name: "Upload a picture" })).toBeVisible();

  await choose(page, "holiday.jpg", "image/jpeg", await photo("#3366cc"));
  await expect(card(page).getByRole("status")).toContainText(/Uploading|Checking your picture/);
  await expect(page.getByText("Profile picture updated")).toBeVisible({ timeout: 30_000 });

  const shown = await shownPicture(page);
  expect(shown.src).toMatch(/^\/api\/v1\/files\/[0-9a-f-]{36}\/content$/);
  expect(shown).toMatchObject({ width: 512, height: 512 });
  // The header's account menu shows it too.
  await expect(page.locator("header img").first()).toHaveAttribute("src", shown.src as string);
  // Served without its metadata.
  const bytes = await page.request.get(shown.src as string).then((r) => r.body());
  expect(bytes.includes(Buffer.from("Location Leak"))).toBe(false);
  expect((await sharp(bytes).metadata()).format).toBe("webp");
});

test("replace, then remove the picture", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings");
  await choose(page, "first.jpg", "image/jpeg", await photo("#aa3333"));
  const first = await shownPicture(page);

  await choose(page, "second.jpg", "image/jpeg", await photo("#33aa33"));
  await expect.poll(async () => (await shownPicture(page)).src).not.toBe(first.src);
  // The old picture is gone.
  expect((await page.request.get(first.src as string, { maxRedirects: 0 })).status()).toBe(404);

  await card(page).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Profile picture removed")).toBeVisible();
  await expect(card(page).locator("img")).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Upload a picture" })).toBeVisible();
});

test("a virus is rejected and never shown", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings");
  await choose(page, "cute-cat.png", "image/png", Buffer.from(EICAR));
  await expect(card(page).getByRole("alert")).toHaveText(
    "That file looks harmful, so it was deleted.",
    { timeout: 30_000 },
  );
  await expect(card(page).locator("img")).toHaveCount(0);
});

test("a file that only pretends to be an image is rejected", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings");
  await choose(page, "me.png", "image/png", Buffer.from("<svg onload=alert(1)></svg>"));
  await expect(card(page).getByRole("alert")).toContainText("That kind of file isn't allowed", {
    timeout: 30_000,
  });
});

test("the wrong type or a file too big is refused before uploading", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings");
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("createUpload")) {
      uploads.push(request.url());
    }
  });

  await choose(page, "notes.txt", "text/plain", Buffer.from("hello"));
  await expect(card(page).getByRole("alert")).toHaveText(
    "That kind of file isn't allowed here. Use one of: image/png, image/jpeg, image/webp, image/gif.",
  );
  await choose(page, "huge.png", "image/png", Buffer.alloc(5_000_001, 1));
  await expect(card(page).getByRole("alert")).toHaveText("That file is too big. The limit is 5MB.");
  expect(uploads).toEqual([]);
});
