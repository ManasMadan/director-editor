import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import ErrorPage from "@/app/error";
import GlobalError from "@/app/global-error";
import { renderPage } from "../render";

describe("error pages", () => {
  it("shows the reference support needs, and tries again", async () => {
    const reset = vi.fn();
    const page = await renderPage(
      <ErrorPage error={Object.assign(new Error("boom"), { digest: "abc123" })} reset={reset} />,
    );
    await expect.element(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
    await expect.element(page.getByText("Reference: abc123")).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("leaves the reference out when there is none", async () => {
    const page = await renderPage(<ErrorPage error={new Error("boom")} reset={vi.fn()} />);
    await expect.element(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
    expect(page.getByText("Reference:", { exact: false }).query()).toBeNull();
  });

  it("leaves the reference out of the root error page when there is none", async () => {
    const page = await renderPage(<GlobalError error={new Error("boom")} reset={vi.fn()} />);
    await expect.element(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
    expect(document.querySelector("p.font-mono")).toBeNull();
  });

  it("recovers from a broken root layout without any providers", async () => {
    const reset = vi.fn();
    const page = await renderPage(
      <GlobalError error={Object.assign(new Error("boom"), { digest: "root-1" })} reset={reset} />,
    );
    await expect.element(page.getByText("root-1")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
