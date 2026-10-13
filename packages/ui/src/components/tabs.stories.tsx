import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const meta = { component: Tabs } satisfies Meta<typeof Tabs>;
export default meta;
type Story = StoryObj<typeof meta>;

const render = (variant: "default" | "line") => () => (
  <Tabs defaultValue="monthly" className="w-80">
    <TabsList variant={variant}>
      <TabsTrigger value="monthly">Monthly</TabsTrigger>
      <TabsTrigger value="yearly">Yearly</TabsTrigger>
    </TabsList>
    <TabsContent value="monthly">€12 per seat, billed monthly.</TabsContent>
    <TabsContent value="yearly">€120 per seat, billed yearly.</TabsContent>
  </Tabs>
);

export const Default: Story = {
  render: render("default"),
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByText("€12 per seat, billed monthly.")).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Yearly" }));
    await expect(canvas.getByRole("tab", { name: "Yearly" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(canvas.getByText("€120 per seat, billed yearly.")).toBeVisible();
    // Arrow keys move between tabs.
    await userEvent.keyboard("{ArrowLeft}");
    await expect(canvas.getByRole("tab", { name: "Monthly" })).toHaveFocus();
  },
};

export const Line: Story = { render: render("line") };
