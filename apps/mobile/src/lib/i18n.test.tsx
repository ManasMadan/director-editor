import { render, screen } from "@testing-library/react-native";
import { Suspense } from "react";
import { Text } from "react-native";
import { useTranslations } from "use-intl";
import { deviceLocale, deviceTimeZone, I18nProvider } from "./i18n";

let mockLocales: { languageTag: string }[] = [];
let mockCalendars: { timeZone: string | null }[] = [];
jest.mock("expo-localization", () => ({
  getLocales: () => mockLocales,
  getCalendars: () => mockCalendars,
}));

describe("the device's language and time zone", () => {
  it.each([
    [["es-MX", "en-US"], "es"],
    [["fr-FR", "en-GB"], "en"],
    [["de-DE"], "en"],
    [[], "en"],
  ])("%j → %s", (tags, locale) => {
    mockLocales = tags.map((languageTag) => ({ languageTag }));
    expect(deviceLocale()).toBe(locale);
  });

  it("falls back to UTC without a calendar zone", () => {
    mockCalendars = [{ timeZone: "Europe/Lisbon" }];
    expect(deviceTimeZone()).toBe("Europe/Lisbon");
    mockCalendars = [];
    expect(deviceTimeZone()).toBe("UTC");
  });
});

function Greeting() {
  return <Text>{useTranslations("common")("signIn")}</Text>;
}

describe("I18nProvider", () => {
  it("renders the catalog's messages in the given language", async () => {
    await render(
      <Suspense fallback={null}>
        <I18nProvider locale="es">
          <Greeting />
        </I18nProvider>
      </Suspense>,
    );
    expect(await screen.findByText("Iniciar sesión")).toBeOnTheScreen();
  });
});
