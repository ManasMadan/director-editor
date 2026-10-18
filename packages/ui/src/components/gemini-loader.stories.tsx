import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { GeminiLoader, GeminiShimmer } from "./gemini-loader";

const meta = {
  component: GeminiLoader,
  args: { label: "Loading" },
} satisfies Meta<typeof GeminiLoader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    // Announced to screen readers even without a visible caption.
    const status = canvas.getByRole("status");
    await expect(status).toBeInTheDocument();
    await expect(status).toHaveAccessibleName("Loading");
    // Nothing visible by default: just the glow and sparkle, captioned only for screen readers.
    await expect(canvas.queryByText("Loading")).not.toBeInTheDocument();
  },
};

export const WithLabel: Story = {
  args: { label: "Generating your video…", showLabel: true },
  play: async ({ canvas }) => {
    const status = canvas.getByRole("status", { name: "Generating your video…" });
    // showLabel draws the caller's label, not just announcing it.
    await expect(canvas.getByText("Generating your video…")).toBeVisible();
    await expect(status).toBeInTheDocument();
  },
};

const SIZE_CLASSES = {
  sm: "size-6",
  md: "size-10",
  lg: "size-16",
} as const;

export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-6">
      {(["sm", "md", "lg"] as const).map((size) => (
        <GeminiLoader key={size} size={size} label={`Loading, ${size}`} showLabel />
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    for (const size of ["sm", "md", "lg"] as const) {
      const status = canvas.getByRole("status", { name: `Loading, ${size}` });
      await expect(status).toHaveAttribute("data-size", size);
      const icon = status.querySelector('[data-slot="gemini-loader-icon"]');
      await expect(icon).toHaveClass(SIZE_CLASSES[size]);
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
