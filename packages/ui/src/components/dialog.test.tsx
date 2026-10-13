import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "../../test/render";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

describe("DialogFooter", () => {
  it("can add a Close button that closes the dialog", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Invite link</DialogTitle>
          </DialogHeader>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>,
    );
    const dialog = page.getByRole("dialog", { name: "Invite link" });
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
  });
});
