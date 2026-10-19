import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, waitFor } from "storybook/test";
import { Button } from "./button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet";

const meta = { component: Sheet } satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger render={<Button variant="outline" />}>See the post</SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>The post Director wrote</SheetTitle>
          <SheetDescription>
            Change anything you like, then send it to your channel.
          </SheetDescription>
        </SheetHeader>
        {Array.from({ length: 12 }, (_, line) => (
          <p key={line}>Line {line + 1} of the post.</p>
        ))}
        <SheetClose render={<Button variant="outline" />}>Done</SheetClose>
      </SheetContent>
    </Sheet>
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "See the post" }));
    const sheet = await screen.findByRole("dialog", { name: "The post Director wrote" });
    await waitFor(() => expect(sheet).toBeVisible());
    // It rests at about half the screen, from the bottom up, under its grabber.
    await waitFor(() =>
      expect(sheet.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight * 0.3),
    );
    await expect(sheet.querySelector("[data-slot=sheet-grabber]")).not.toBeNull();
    // Escape closes it, and focus returns to what opened it.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await expect(canvas.getByRole("button", { name: "See the post" })).toHaveFocus();
    // Its own button closes it too.
    await userEvent.click(canvas.getByRole("button", { name: "See the post" }));
    await userEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  },
};
