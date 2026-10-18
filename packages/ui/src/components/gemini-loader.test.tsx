import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "../../test/render";
import { GeminiLoader } from "./gemini-loader";

describe("GeminiLoader", () => {
  it("is a span inside a button, where a div isn't allowed, and still says what's loading", async () => {
    render(
      <button type="button" disabled>
        <GeminiLoader as="span" label="Sending" size="sm" />
      </button>,
    );
    const loader = page.getByRole("status", { name: "Sending" });
    await expect.element(loader).toBeInTheDocument();
    expect(loader.element().tagName).toBe("SPAN");
    expect(loader.element().closest("button")?.querySelector("div")).toBeNull();
  });

  it("is a div by default", async () => {
    render(<GeminiLoader label="Loading" showLabel />);
    const loader = page.getByRole("status", { name: "Loading" });
    await expect.element(loader).toBeInTheDocument();
    expect(loader.element().tagName).toBe("DIV");
    await expect.element(page.getByText("Loading")).toBeVisible();
  });
});
