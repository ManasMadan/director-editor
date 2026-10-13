import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Textarea } from "./textarea";

const meta = {
  component: Textarea,
  args: { "aria-label": "Notes", placeholder: "Anything we should know?" },
} satisfies Meta<typeof Textarea>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas, userEvent }) => {
    const textarea = canvas.getByRole("textbox", { name: "Notes" });
    await userEvent.type(textarea, "Two lines{enter}of text");
    await expect(textarea).toHaveValue("Two lines\nof text");
  },
};
export const Invalid: Story = { args: { "aria-invalid": true } };
export const Disabled: Story = { args: { disabled: true } };
