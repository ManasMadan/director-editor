/**
 * Translations for the app: the catalog shared with every other surface
 * (packages/i18n), through use-intl, in the user's saved language once signed in and
 * the device's language before.
 */
import { bundledMessages, type Locale, type Messages, negotiateLocale } from "@repo/i18n";
import { getCalendars, getLocales } from "expo-localization";
import { type ReactNode, use } from "react";
import { IntlProvider } from "use-intl";

export const deviceLocale = (): Locale =>
  negotiateLocale(getLocales().map((locale) => locale.languageTag));

export const deviceTimeZone = () => getCalendars()[0]?.timeZone ?? "UTC";

const loading = new Map<Locale, Promise<Messages>>();
const messagesFor = (locale: Locale) => {
  let pending = loading.get(locale);
  if (!pending) {
    pending = bundledMessages.load(locale);
    loading.set(locale, pending);
  }
  return pending;
};

/** Suspends until the locale's messages are loaded (instant: they're bundled). */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <IntlProvider locale={locale} messages={use(messagesFor(locale))} timeZone={deviceTimeZone()}>
      {children}
    </IntlProvider>
  );
}
