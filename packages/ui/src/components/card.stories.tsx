import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Button } from "./button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card";

const meta = { component: Card } satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card className="w-96">
      <CardHeader>
        <CardTitle>Two-step verification</CardTitle>
        <CardDescription>A code from your authenticator app at every sign-in.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm">
            Turn on
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>It protects your account even if your password leaks.</CardContent>
      <CardFooter className="text-muted-foreground text-sm">Recommended</CardFooter>
    </Card>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Two-step verification")).toHaveAttribute(
      "data-slot",
      "card-title",
    );
    // The header's action is a real button, named by its label.
    await expect(canvas.getByRole("button", { name: "Turn on" })).toBeEnabled();
    await expect(
      canvas.getByText("It protects your account even if your password leaks."),
    ).toBeVisible();
  },
};
