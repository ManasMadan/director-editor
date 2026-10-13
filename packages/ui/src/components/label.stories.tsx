import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Input } from "./input";
import { Label } from "./label";

const meta = { component: Label } satisfies Meta<typeof Label>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithInput: Story = {
  render: () => (
    <div className="grid gap-2">
      <Label htmlFor="name">Full name</Label>
      <Input id="name" />
    </div>
  ),
  play: async ({ canvas, userEvent }) => {
    // Clicking the label focuses its input.
    await userEvent.click(canvas.getByText("Full name"));
    await expect(canvas.getByRole("textbox", { name: "Full name" })).toHaveFocus();
  },
};
