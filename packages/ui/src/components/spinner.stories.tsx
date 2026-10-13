import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Spinner } from "./spinner";

const meta = { component: Spinner } satisfies Meta<typeof Spinner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    // Announced to screen readers, not just drawn.
    await expect(canvas.getByRole("status")).toBeInTheDocument();
  },
};
