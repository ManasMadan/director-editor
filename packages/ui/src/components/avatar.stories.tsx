import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from "./avatar";

const meta = { component: Avatar } satisfies Meta<typeof Avatar>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Without a loadable image, the initials show. */
export const Fallback: Story = {
  render: () => (
    <Avatar>
      <AvatarImage src="/missing.png" alt="Ada Lovelace" />
      <AvatarFallback>AL</AvatarFallback>
    </Avatar>
  ),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("AL")).toBeVisible();
  },
};

export const Sizes: Story = {
  render: () => (
    <AvatarGroup>
      {(["sm", "default", "lg"] as const).map((size) => (
        <Avatar key={size} size={size}>
          <AvatarFallback>{size.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      ))}
    </AvatarGroup>
  ),
};
