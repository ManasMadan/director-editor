import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";
import { Button } from "./button";

const meta = {
  component: AlertDialog,
  args: { onOpenChange: fn() },
} satisfies Meta<typeof AlertDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

const onDelete = fn();

export const Confirm: Story = {
  render: (args) => (
    <AlertDialog {...args}>
      <AlertDialogTrigger render={<Button variant="destructive" />}>
        Delete workspace
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            Its todos, documents and settings are deleted too. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  play: async ({ canvas, userEvent }) => {
    // Cancelling does nothing.
    await userEvent.click(canvas.getByRole("button", { name: "Delete workspace" }));
    await userEvent.click(await screen.findByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await expect(onDelete).not.toHaveBeenCalled();
    // Confirming does.
    await userEvent.click(canvas.getByRole("button", { name: "Delete workspace" }));
    const dialog = await screen.findByRole("alertdialog");
    // It fades in.
    await waitFor(() => expect(dialog).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await expect(onDelete).toHaveBeenCalledOnce();
  },
};
