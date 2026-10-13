import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { AssistantPage } from "@/modules/assistant";
import { renderPage } from "../render";
import { signUp } from "../users";

it("says the assistant isn't available when the AI service is off", async () => {
  await signUp();
  const page = await renderPage(<AssistantPage />, { url: "/assistant" });
  await expect.element(page.getByText("This feature isn't available.").first()).toBeVisible();
  await userEvent.fill(page.getByRole("textbox", { name: "Your question" }), "Anyone there?");
  await userEvent.click(page.getByRole("button", { name: "Ask" }));
  await expect.poll(() => page.getByText("This feature isn't available.").all().length).toBe(2);
});
