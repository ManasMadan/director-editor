import { expect, it } from "vitest";
import { DashboardPage } from "@/modules/dashboard";
import { renderPage } from "../render";
import { signUp } from "../users";

it("says the AI service isn't configured, and doesn't offer it", async () => {
  await signUp();
  const page = await renderPage(<DashboardPage />, { url: "/dashboard" });
  await expect.element(page.getByText("The AI service isn't configured.")).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Sentiment (Python)" })).toBeDisabled();
});
