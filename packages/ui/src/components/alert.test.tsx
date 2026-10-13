import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "../../test/render";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert";
import { Button } from "./button";

describe("Alert", () => {
  it("offers an action in its corner", async () => {
    const onRetry = vi.fn();
    render(
      <Alert>
        <AlertTitle>Payment failed</AlertTitle>
        <AlertDescription>Your card was declined.</AlertDescription>
        <AlertAction>
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        </AlertAction>
      </Alert>,
    );
    const alert = page.getByRole("alert");
    await expect.element(alert.getByText("Payment failed")).toBeVisible();
    await alert.getByRole("button", { name: "Retry" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
