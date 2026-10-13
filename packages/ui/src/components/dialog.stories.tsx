import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, waitFor } from "storybook/test";
import { Button } from "./button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import { Input } from "./input";
import { Label } from "./label";

const meta = { component: Dialog } satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" />}>Rename workspace</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename workspace</DialogTitle>
          <DialogDescription>Members see the new name straight away.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="workspace-name">Name</Label>
          <Input id="workspace-name" defaultValue="Acme" />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Rename workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename workspace" });
    // It fades in.
    await waitFor(() => expect(dialog).toBeVisible());
    // Escape closes it, and focus returns to the trigger.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await expect(canvas.getByRole("button", { name: "Rename workspace" })).toHaveFocus();
  },
};
