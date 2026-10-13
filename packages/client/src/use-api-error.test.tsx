import { ORPCError } from "@orpc/client";
import en from "@repo/i18n/messages/en.json" with { type: "json" };
import { act } from "react";
import { create } from "react-test-renderer";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { useApiErrorMessage } from "./use-api-error";

/** The hook's translator, rendered inside use-intl's provider (next-intl's on web). */
function translator() {
  let message: ReturnType<typeof useApiErrorMessage> | undefined;
  function Probe() {
    message = useApiErrorMessage();
    return null;
  }
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  act(() => {
    create(
      <IntlProvider locale="en" messages={en}>
        <Probe />
      </IntlProvider>,
    );
  });
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  return message as ReturnType<typeof useApiErrorMessage>;
}

describe("useApiErrorMessage", () => {
  it("translates the error's code with its params, never the server's own message", () => {
    const message = translator();
    const limited = new ORPCError("RATE_LIMITED", {
      message: "rate limit hit",
      data: { params: { retryAfterSeconds: 3 } },
    });
    expect(message(limited)).toBe("Too many attempts. Try again in 3 seconds.");
    expect(message(new Error("socket hang up"))).toBe(en.errors.INTERNAL);
  });
});
