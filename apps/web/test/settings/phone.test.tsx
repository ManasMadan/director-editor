import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { PhoneCard } from "@/modules/settings/components/phone-card";
import { renderPage } from "../render";
import { signUp } from "../users";

const newNumber = () => `+1415555${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
const code = async (phone: string) =>
  (await commands.takeNotification<{ code: string }>("auth.phone-code", phone)).code;

async function showPhone() {
  await signUp();
  const page = await renderPage(<PhoneCard />, { url: "/settings/security" });
  await expect.element(page.getByText("No phone number yet.")).toBeVisible();
  return page;
}

async function sendTo(page: Awaited<ReturnType<typeof renderPage>>, phone: string) {
  await userEvent.fill(page.getByLabelText("Phone number"), phone);
  await userEvent.click(page.getByRole("button", { name: "Text me a code" }));
}

describe("the phone number", () => {
  it("is added with a texted code, then changed and removed", async () => {
    const page = await showPhone();
    await userEvent.click(page.getByRole("button", { name: "Add a phone number" }));
    await sendTo(page, "12345");
    await expect
      .element(page.getByText("Enter the number with its country code, like +14155550123"))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await userEvent.click(page.getByRole("button", { name: "Add a phone number" }));

    const phone = newNumber();
    await sendTo(page, phone);
    await expect.element(page.getByText(`We texted a code to ${phone}.`)).toBeVisible();
    const first = await code(phone);
    await userEvent.fill(
      page.getByLabelText("Code from the text"),
      first === "000000" ? "111111" : "000000",
    );
    await userEvent.click(page.getByRole("button", { name: "Verify" }));
    await expect
      .element(page.getByText("That code isn't right, or it expired.", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Code from the text")).toHaveValue("");

    await userEvent.click(page.getByRole("button", { name: "Send a new code" }));
    await expect.element(page.getByText(`We texted a code to ${phone}.`).last()).toBeVisible();
    const second = await code(phone);
    await userEvent.fill(page.getByLabelText("Code from the text"), second);
    await userEvent.click(page.getByRole("button", { name: "Verify" }));
    await expect.element(page.getByText("Phone number saved")).toBeVisible();
    await expect.element(page.getByText(phone, { exact: true })).toBeVisible();

    // The code step's cancel goes back to the number.
    await userEvent.click(page.getByRole("button", { name: "Change number" }));
    const next = newNumber();
    await sendTo(page, next);
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await expect.element(page.getByLabelText("Phone number")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));

    await userEvent.click(page.getByRole("button", { name: "Remove" }));
    await expect.element(page.getByText("Phone number removed")).toBeVisible();
    await expect.element(page.getByText("No phone number yet.")).toBeVisible();
  });

  it("says so when the number is already the account's", async () => {
    const page = await showPhone();
    const phone = newNumber();
    await userEvent.click(page.getByRole("button", { name: "Add a phone number" }));
    await sendTo(page, phone);
    await userEvent.fill(page.getByLabelText("Code from the text"), await code(phone));
    await userEvent.click(page.getByRole("button", { name: "Verify" }));
    await expect.element(page.getByText(phone, { exact: true })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Change number" }));
    await sendTo(page, phone);
    await expect.element(page.getByText("That number is already on an account.")).toBeVisible();
  });

  it("asks for a new sign-in when the session is too old to add one", async () => {
    const page = await showPhone();
    await commands.ageSession();
    await userEvent.click(page.getByRole("button", { name: "Add a phone number" }));
    await sendTo(page, newNumber());
    await expect.element(page.getByText("Confirm it's you")).toBeVisible();
  });

  it("asks for a new sign-in when the session got too old before verifying", async () => {
    const page = await showPhone();
    const phone = newNumber();
    await userEvent.click(page.getByRole("button", { name: "Add a phone number" }));
    await sendTo(page, phone);
    const texted = await code(phone);
    await commands.ageSession();
    await userEvent.fill(page.getByLabelText("Code from the text"), texted);
    await userEvent.click(page.getByRole("button", { name: "Verify" }));
    await expect.element(page.getByText("Confirm it's you")).toBeVisible();
  });

  it("says so when a new code can't be sent", async () => {
    const page = await showPhone();
    const phone = newNumber();
    await userEvent.click(page.getByRole("button", { name: "Add a phone number" }));
    await sendTo(page, phone);
    await expect.element(page.getByText(`We texted a code to ${phone}.`)).toBeVisible();
    await commands.ageSession();
    await userEvent.click(page.getByRole("button", { name: "Send a new code" }));
    await expect.element(page.getByText("Confirm it's you")).toBeVisible();
  });
});
