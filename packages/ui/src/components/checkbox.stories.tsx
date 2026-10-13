import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { Checkbox } from "./checkbox";
import { Label } from "./label";

const meta = {
  component: Checkbox,
  args: { onCheckedChange: fn() },
  render: (args) => (
    <div className="flex items-center gap-2">
      <Checkbox id="terms" {...args} />
      <Label htmlFor="terms">Accept the terms</Label>
    </div>
  ),
} satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas, userEvent, args }) => {
    const checkbox = canvas.getByRole("checkbox", { name: "Accept the terms" });
    await userEvent.click(checkbox);
    await expect(checkbox).toBeChecked();
    await expect(args.onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    // Space toggles it back for keyboard users.
    await userEvent.keyboard(" ");
    await expect(checkbox).not.toBeChecked();
  },
};
export const Checked: Story = { args: { defaultChecked: true } };
export const Disabled: Story = { args: { disabled: true } };
