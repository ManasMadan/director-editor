import type { Meta, StoryObj } from "@storybook/react-vite";
import { toast } from "sonner";
import { expect, screen, waitFor } from "storybook/test";
import { Button } from "./button";
import { Toaster } from "./sonner";

const meta = { component: Toaster } satisfies Meta<typeof Toaster>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Messages: Story = {
  render: () => (
    <>
      <Toaster />
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => toast.success("Workspace renamed")}>
          Success
        </Button>
        <Button variant="outline" onClick={() => toast.error("That didn't work. Try again.")}>
          Error
        </Button>
      </div>
    </>
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Success" }));
    // Toasts slide in.
    const success = await screen.findByText("Workspace renamed");
    await waitFor(() => expect(success).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: "Error" }));
    const failure = await screen.findByText("That didn't work. Try again.");
    await waitFor(() => expect(failure).toBeVisible());
  },
};
