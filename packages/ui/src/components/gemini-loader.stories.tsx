import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { GeminiLoader, GeminiShimmer } from "./gemini-loader";

const meta = { component: GeminiLoader } satisfies Meta<typeof GeminiLoader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    // Announced to screen readers even without a caption of its own.
    const status = canvas.getByRole("status");
    await expect(status).toBeInTheDocument();
    await expect(status).toHaveAccessibleName("Loading");
    // Nothing visible by default: just the glow and sparkle, captioned only for screen readers.
    await expect(canvas.queryByText("Loading")).not.toBeInTheDocument();
  },
};

export const WithLabel: Story = {
  args: { label: "Generating your video…" },
  play: async ({ canvas }) => {
    const status = canvas.getByRole("status", { name: "Generating your video…" });
    // A label the caller passes is shown, not just announced.
    await expect(canvas.getByText("Generating your video…")).toBeVisible();
    await expect(status).toBeInTheDocument();
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-6">
      {(["sm", "md", "lg"] as const).map((size) => (
        <GeminiLoader key={size} size={size} label={size} />
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    for (const size of ["sm", "md", "lg"]) {
      await expect(canvas.getByRole("status", { name: size })).toHaveAttribute("data-size", size);
    }
  },
};

export const Shimmer: Story = {
  render: () => (
    <div className="flex w-72 flex-col gap-2">
      <GeminiShimmer className="h-4" />
      <GeminiShimmer className="h-4 w-2/3" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const shapes = canvasElement.querySelectorAll('[data-slot="gemini-shimmer"]');
    await expect(shapes).toHaveLength(2);
    // Decorative only: nothing in them for a screen reader to read out.
    for (const shape of shapes) {
      await expect(shape).toHaveTextContent("");
    }
  },
};
