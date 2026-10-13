import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "../../test/render";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

describe("DropdownMenu", () => {
  it("toggles a checkbox item, and opens a submenu to pick from", async () => {
    const onCompact = vi.fn();
    const onMove = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>Todo</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked={false} onCheckedChange={onCompact}>
            Compact view
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem>
            Rename <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={onMove}>Acme</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await page.getByRole("button", { name: "Todo" }).click();
    const compact = page.getByRole("menuitemcheckbox", { name: "Compact view" });
    await expect.element(compact).not.toBeChecked();
    await compact.click();
    expect(onCompact).toHaveBeenCalledWith(true, expect.anything());
    await expect.element(page.getByText("⌘R")).toBeVisible();

    await page.getByRole("menuitem", { name: "Move to" }).click();
    await page.getByRole("menuitem", { name: "Acme" }).click();
    expect(onMove).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
  });

  it("portals content of its own out of the page", async () => {
    const container = render(
      <DropdownMenu open>
        <DropdownMenuPortal>
          <p>Outside the page</p>
        </DropdownMenuPortal>
      </DropdownMenu>,
    );
    const portalled = page.getByText("Outside the page");
    await expect.element(portalled).toBeInTheDocument();
    expect(container.contains(portalled.element())).toBe(false);
  });
});
