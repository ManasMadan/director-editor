import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Separator } from "./separator";

const meta = { component: Separator } satisfies Meta<typeof Separator>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <div className="w-64">
      <p>Account</p>
      <Separator className="my-2" />
      <p>Security</p>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("separator")).toHaveAttribute("aria-orientation", "horizontal");
  },
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-6 items-center gap-2">
      <span>Docs</span>
      <Separator orientation="vertical" />
      <span>Support</span>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical");
  },
};
