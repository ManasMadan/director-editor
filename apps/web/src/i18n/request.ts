/**
 * Picks the language and time zone for each server render, so HTML arrives already
 * translated (no flash of English) and dates render in the user's zone.
 *
 * Order: the `locale` cookie (set when the user picks a language, and after sign-in
 * from their saved preference), then the browser's Accept-Language, then English.
 * Messages load through packages/i18n; see its MessageSource seam to serve edited copy
 * from a database later.
 */
import { bundledMessages, isLocale, negotiateLocale } from "@repo/i18n";
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

export const LOCALE_COOKIE = "locale";
export const TIME_ZONE_COOKIE = "tz";

// Right-to-left languages; extend when adding e.g. Arabic or Hebrew to packages/i18n.
const RTL = new Set(["ar", "he", "fa", "ur"]);

/** The `dir` of a page in `locale`. */
export const textDirection = (locale: string) => (RTL.has(locale) ? "rtl" : "ltr");

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const saved = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(saved)
    ? saved
    : negotiateLocale((await headers()).get("accept-language"));
  const timeZone = cookieStore.get(TIME_ZONE_COOKIE)?.value ?? "UTC";
  return { locale, timeZone, messages: await bundledMessages.load(locale) };
});
