import { TriangleAlertIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "../../test/render";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "./alert-dialog";

describe("AlertDialog", () => {
  it("shows an icon above its title", async () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <TriangleAlertIcon aria-label="Warning" />
            </AlertDialogMedia>
            <AlertDialogTitle>Leave the workspace?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const dialog = page.getByRole("alertdialog", { name: "Leave the workspace?" });
    await expect.element(dialog.getByLabelText("Warning")).toBeVisible();
    await dialog.getByRole("button", { name: "Stay" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
  });
});
