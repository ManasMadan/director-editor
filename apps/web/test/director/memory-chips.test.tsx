/** What Director remembers, as chips on the shoot screen: each one forgotten with its ×. */
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { MemoryChips } from "@/modules/director/components/memory-chips";
import { renderPage } from "../render";

describe("Director's memory chips", () => {
  it("shows each note, and forgets the one whose × is tapped", async () => {
    const onForget = vi.fn();
    const page = await renderPage(
      <MemoryChips
        notes={[
          { kind: "place", note: "Inside" },
          { kind: "props", note: "The red mug" },
        ]}
        onForget={onForget}
      />,
    );
    const chips = page.getByRole("list", { name: "What Director remembers" });
    await expect.element(chips.getByText("Inside")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Forget “The red mug”" }));
    expect(onForget).toHaveBeenCalledWith({ kind: "props", note: "The red mug" });
  });

  it("shows nothing before Director remembers anything", async () => {
    const page = await renderPage(<MemoryChips notes={[]} onForget={() => undefined} />);
    expect(page.getByRole("list").query()).toBeNull();
  });
});
