/** Sign-in where the API has no demo account and no Google sign-in. */
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { SignInPage } from "@/modules/auth";
import { renderPage } from "../render";

describe("sign in, with the optional features off", () => {
  it("offers neither the demo account nor Google, and ?demo=1 leaves the form empty", async () => {
    const page = await renderPage(<SignInPage />, { url: "/sign-in?demo=1" });
    await expect.poll(() => commands.answeredRequests("/rpc/system/info")).toBeGreaterThan(0);
    await expect
      .element(page.getByRole("button", { name: "Sign in with a passkey" }))
      .toBeVisible();
    expect(page.getByText("Try Director with the demo account").elements()).toHaveLength(0);
    expect(page.getByRole("status").elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Continue with Google" }).elements()).toHaveLength(0);
    await expect.element(page.getByLabelText("Email")).toHaveValue("");
  });
});
