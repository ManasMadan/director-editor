/** The profile picture: uploaded to storage, checked by the worker, then shown. */
import { describe, expect, it } from "vitest";
import { page as browserPage, commands, userEvent } from "vitest/browser";
import { AvatarCard } from "@/modules/settings/components/avatar-card";
import { renderPage } from "../render";
import { signUp, type User } from "../users";

// A 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);
const picture = () => new File([PNG], "me.png", { type: "image/png" });

const fileInput = () =>
  browserPage.elementLocator(document.querySelector("input[type=file]") as HTMLElement);

async function showCard() {
  await commands.storageCors();
  const user = await signUp();
  const page = await renderPage(<AvatarCard />, { url: "/settings" });
  await expect.element(page.getByRole("button", { name: "Upload a picture" })).toBeVisible();
  return { user, page };
}

/** The upload the API recorded last, once storage has it. */
async function uploaded(user: User) {
  let id: string | undefined;
  await expect
    .poll(async () => {
      [{ id } = { id: undefined }] = await commands.sql<{ id: string }>(
        "SELECT id::text FROM files.file WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [user.id],
      );
      return id;
    })
    .toBeDefined();
  return id as string;
}

/** What apps/worker records after checking a file (it isn't running in these tests). */
const checked = (id: string, set: string) =>
  commands.sql(`UPDATE files.file SET ${set}, updated_at = now() WHERE id = $1`, [id]);

// Uploads go to RustFS: the files profile (`bun run test:integration:files`).
describe("the profile picture", { tags: ["files"] }, () => {
  it("is uploaded, checked, shown, and removed", async () => {
    const { user, page } = await showCard();
    await userEvent.click(page.getByRole("button", { name: "Upload a picture" }));
    await userEvent.upload(fileInput(), picture());
    await expect.element(page.getByText("Checking your picture…")).toBeVisible();
    await checked(await uploaded(user), "status = 'ready', ready_at = now()");
    await expect.element(page.getByText("Profile picture updated")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Change picture" })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Remove" }));
    await expect.element(page.getByText("Profile picture removed")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Upload a picture" })).toBeVisible();
  });

  it.each([
    ["FILE_INFECTED", "That file looks harmful, so it was deleted."],
    [null, "That file couldn't be read. It may be damaged; try another."],
  ])("says why the worker refused it (%s)", async (reason, message) => {
    const { user, page } = await showCard();
    await userEvent.upload(fileInput(), picture());
    await checked(
      await uploaded(user),
      `status = 'rejected', reject_reason = ${reason ? `'${reason}'` : "NULL"}`,
    );
    await expect.element(page.getByRole("alert")).toHaveTextContent(message);
    await expect.element(page.getByRole("button", { name: "Upload a picture" })).toBeEnabled();
  });

  it("refuses the wrong kind of file, or one too big, before uploading", async () => {
    const { page } = await showCard();
    await userEvent.upload(fileInput(), new File(["hello"], "notes.txt", { type: "text/plain" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "That kind of file isn't allowed here. Use one of: image/png, image/jpeg, image/webp, image/gif.",
      );
    await userEvent.upload(
      fileInput(),
      new File([new Uint8Array(5_000_001)], "huge.png", { type: "image/png" }),
    );
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("That file is too big. The limit is 5MB.");
  });

  it("does nothing when no file was chosen", async () => {
    const { page } = await showCard();
    fileInput()
      .element()
      .dispatchEvent(new Event("change", { bubbles: true }));
    await expect.element(page.getByRole("button", { name: "Upload a picture" })).toBeEnabled();
    expect(page.getByRole("alert").query()).toBeNull();
  });

  it("says so when storage refuses the upload", async () => {
    const { page } = await showCard();
    await commands.refuseNextPut(":59000/", 503);
    await userEvent.upload(fileInput(), picture());
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The file didn't finish uploading. Try again.");
  });

  it("says so when the API can't be reached for the upload", async () => {
    const { page } = await showCard();
    await commands.failRequests("/rpc/files/createUpload");
    await userEvent.upload(fileInput(), picture());
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("We can't reach the server. Check your connection and try again.");
  });

  it("says so when the checked picture can't be set, or removed", async () => {
    const { user, page } = await showCard();
    await userEvent.upload(fileInput(), picture());
    await checked(await uploaded(user), "status = 'ready', ready_at = now()");
    await expect.element(page.getByRole("button", { name: "Remove" })).toBeVisible();

    await commands.failRequests("/rpc/user/setAvatar");
    await userEvent.click(page.getByRole("button", { name: "Remove" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("We can't reach the server. Check your connection and try again.");

    await userEvent.upload(fileInput(), picture());
    await expect.element(page.getByText("Checking your picture…")).toBeVisible();
    await checked(await uploaded(user), "status = 'ready', ready_at = now()");
    await expect.element(page.getByRole("button", { name: "Change picture" })).toBeEnabled();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("We can't reach the server. Check your connection and try again.");
  });
});
