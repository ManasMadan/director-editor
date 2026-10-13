import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Skeleton } from "./skeleton";

const meta = { component: Skeleton } satisfies Meta<typeof Skeleton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Row: Story = {
  render: () => (
    <div className="flex w-72 items-center gap-3">
      <Skeleton className="size-10 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const shapes = canvasElement.querySelectorAll('[data-slot="skeleton"]');
    await expect(shapes).toHaveLength(3);
    // Placeholders only: nothing in them for a screen reader to read out.
    for (const shape of shapes) {
      await expect(shape).toBeEmptyDOMElement();
    }
  },
};
