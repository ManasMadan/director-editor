/** Indexing's progress: an honest estimate, and how long it's been at it. */
import { describe, expect, it } from "vitest";
import { IndexProgress } from "@/modules/director/components/index-progress";
import { renderPage } from "../render";

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

describe("indexing's progress", () => {
  it("says nothing of the time for the first seconds", async () => {
    const page = await renderPage(<IndexProgress step="watching" since={ago(2)} />);
    await expect
      .element(page.getByText("This usually takes one to three minutes.", { exact: false }))
      .toBeVisible();
    expect(page.getByText("Still working", { exact: false }).query()).toBeNull();
  });

  it("says it's still working, and for how long, once it's taking a while", async () => {
    const page = await renderPage(<IndexProgress step="watching" since={ago(75)} />);
    await expect.element(page.getByText(/^Still working: 01:1\d so far$/)).toBeVisible();
    // It counts on, a second at a time.
    await expect.element(page.getByText(/^Still working: 01:1[6-9] so far$/)).toBeVisible();
  });

  it("says nothing of the time when it doesn't know when the step started", async () => {
    const page = await renderPage(<IndexProgress step="writing" />);
    await expect
      .element(page.getByRole("list", { name: "Indexing progress" }).getByRole("listitem").nth(2))
      .toHaveAttribute("aria-current", "step");
    expect(page.getByText("so far", { exact: false }).query()).toBeNull();
  });

  it("says when it's taking longer than usual", async () => {
    const page = await renderPage(<IndexProgress step="writing" since={ago(300)} />);
    await expect
      .element(page.getByText("Taking longer than usual, but still going", { exact: false }))
      .toBeVisible();
  });
});
