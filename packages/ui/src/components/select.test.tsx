import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "../../test/render";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";

describe("Select", () => {
  it("groups options under labels, with a separator between groups", async () => {
    render(
      <Select
        defaultValue="utc"
        items={[
          { value: "utc", label: "UTC" },
          { value: "lisbon", label: "Lisbon" },
        ]}
      >
        <SelectTrigger aria-label="Time zone">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Common</SelectLabel>
            <SelectItem value="utc">UTC</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Europe</SelectLabel>
            <SelectItem value="lisbon">Lisbon</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );
    await page.getByRole("combobox", { name: "Time zone" }).click();
    const europe = page.getByRole("group", { name: "Europe" });
    await expect.element(europe).toBeVisible();
    const separator = europe.element().previousElementSibling;
    expect(separator?.getAttribute("data-slot")).toBe("select-separator");
    expect(separator?.previousElementSibling).toBe(
      page.getByRole("group", { name: "Common" }).element(),
    );
    await page.getByRole("option", { name: "Lisbon" }).click();
    const trigger = page.getByRole("combobox", { name: "Time zone" });
    await expect.element(trigger.getByText("Lisbon")).toBeVisible();
  });
});
