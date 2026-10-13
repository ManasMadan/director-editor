import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "./input-otp";

// InputOTP takes either slots as children or a render function, a union Storybook's args
// can't express, so the story renders it directly.
const meta = { title: "InputOTP" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const onComplete = fn();

export const Default: Story = {
  render: () => (
    <InputOTP
      maxLength={6}
      inputMode="numeric"
      aria-label="Verification code"
      onComplete={onComplete}
    >
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        <InputOTPSlot index={3} />
        <InputOTPSlot index={4} />
        <InputOTPSlot index={5} />
      </InputOTPGroup>
    </InputOTP>
  ),
  play: async ({ canvas, userEvent }) => {
    const input = canvas.getByRole("textbox", { name: "Verification code" });
    await userEvent.click(input);
    await userEvent.keyboard("123456");
    await expect(input).toHaveValue("123456");
    await expect(onComplete).toHaveBeenCalledWith("123456");
  },
};
