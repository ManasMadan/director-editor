import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Input } from "./input";

const meta = {
  component: Input,
  args: { "aria-label": "Email", placeholder: "you@example.com", type: "email" },
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas, userEvent }) => {
    const input = canvas.getByRole("textbox", { name: "Email" });
    await userEvent.type(input, "ada@example.com");
    await expect(input).toHaveValue("ada@example.com");
  },
};

export const Invalid: Story = { args: { "aria-invalid": true, defaultValue: "not-an-email" } };
export const Disabled: Story = { args: { disabled: true, defaultValue: "ada@example.com" } };
