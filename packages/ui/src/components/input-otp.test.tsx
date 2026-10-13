import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "../../test/render";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "./input-otp";

describe("InputOTPSlot", () => {
  it("stays empty for a position past the code's length", async () => {
    render(
      <InputOTP maxLength={2} aria-label="Code">
        <InputOTPGroup>
          <InputOTPSlot index={0} data-testid="slot" />
          <InputOTPSlot index={1} data-testid="slot" />
          <InputOTPSlot index={2} data-testid="slot" />
        </InputOTPGroup>
      </InputOTP>,
    );
    await page.getByRole("textbox", { name: "Code" }).click();
    await userEvent.keyboard("12");
    const slots = page.getByTestId("slot");
    await expect.element(slots.nth(1)).toHaveTextContent("2");
    expect(slots.elements().map((slot) => slot.textContent)).toEqual(["1", "2", ""]);
  });
});
