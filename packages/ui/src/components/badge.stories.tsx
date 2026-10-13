import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Badge } from "./badge";

const meta = { component: Badge } satisfies Meta<typeof Badge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(["default", "secondary", "destructive", "outline", "ghost", "link"] as const).map(
        (variant) => (
          <Badge key={variant} variant={variant}>
            {variant}
          </Badge>
        ),
      )}
    </div>
  ),
  play: async ({ canvas }) => {
    for (const variant of ["default", "secondary", "destructive", "outline", "ghost", "link"]) {
      const badge = canvas.getByText(variant);
      // A label, not a control.
      await expect(badge.tagName).toBe("SPAN");
      await expect(badge).toHaveAttribute("data-variant", variant);
    }
  },
};
