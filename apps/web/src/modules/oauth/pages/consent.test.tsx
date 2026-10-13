import { ApiProvider } from "@repo/client";
import { bundledMessages } from "@repo/i18n";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { renderHtml } from "../../../../test/next-server";
import { OAuthConsentPage } from "./consent";

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams({
      client_id: "app",
      sig: "signed",
      scope: "openid",
      redirect_uri: "http://127.0.0.1:9/cb",
    }),
}));

describe("the consent page, as the server renders it", () => {
  // Before the browser runs the page's code, a click on an enabled button does nothing:
  // neither answer may be offered until the page has loaded the app's details.
  it("offers neither answer yet", async () => {
    const html = await renderHtml(
      <NextIntlClientProvider locale="en" messages={await bundledMessages.load("en")}>
        <ApiProvider options={{}}>
          <OAuthConsentPage />
        </ApiProvider>
      </NextIntlClientProvider>,
    );
    const answers = [...html.matchAll(/<button([^>]*)>(Allow|Deny)</g)].map((match) => [
      match[2],
      / disabled=""/.test(match[1] ?? ""),
    ]);
    expect(answers).toEqual([
      ["Allow", true],
      ["Deny", true],
    ]);
  });
});
