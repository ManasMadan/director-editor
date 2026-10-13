import type { Meta, StoryObj } from "@storybook/react-vite";
import { CircleAlert, Info } from "lucide-react";
import { expect } from "storybook/test";
import { Alert, AlertDescription, AlertTitle } from "./alert";

const meta = { component: Alert } satisfies Meta<typeof Alert>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Alert className="w-96">
      <Info />
      <AlertTitle>Heads up</AlertTitle>
      <AlertDescription>Your trial ends in three days.</AlertDescription>
    </Alert>
  ),
  play: async ({ canvas }) => {
    const alert = canvas.getByRole("alert");
    await expect(alert).toHaveTextContent("Heads upYour trial ends in three days.");
    // The icon is decoration: screen readers hear only the words.
    await expect(alert.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  },
};

export const Destructive: Story = {
  render: () => (
    <Alert variant="destructive" className="w-96">
      <CircleAlert />
      <AlertTitle>Payment failed</AlertTitle>
      <AlertDescription>Update your card to keep the workspace on Pro.</AlertDescription>
    </Alert>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Payment failedUpdate your card to keep the workspace on Pro.",
    );
  },
};
