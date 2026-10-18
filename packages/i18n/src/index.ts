/**
 * The single catalog of user-facing text for every surface.
 *
 * - Web (next-intl) and mobile (use-intl) load messages through an async loader.
 * - Servers (emails) get a translator from
 *   `createI18n(source).getTranslator(locale)`, using the same ICU message format, so
 *   plurals, dates and numbers are formatted identically everywhere.
 *
 * Where messages come from is behind the `MessageSource` interface. Today the source
 * is the JSON bundled in this package (`bundledMessages`), so changing copy needs a
 * deploy. To edit copy without deploying, implement `MessageSource` over a database
 * table (e.g. `i18n.message(locale, key, value)`), cached in Redis and invalidated on
 * write, validate rows against English's shape before serving them, and pass it to
 * `createI18n` instead. Every caller is already async, so no call site changes.
 *
 * Adding a language: copy messages/en.json to messages/<code>.json, translate it, and
 * add the code to `locales` and `catalogs`. Every catalog is type-checked against
 * English's shape, so a missing key fails `check-types` instead of rendering a raw key,
 * and a test checks each translation takes the same ICU arguments as English.
 *
 * English is typed with each message's literal text (messages/en.d.json.ts, from
 * `bun run gen`), so `t("key", args)` checks the arguments the message names.
 */
import { createTranslator } from "use-intl/core";
import en from "../messages/en.json" with { type: "json" };

import type { Locale } from "./locales";

export * from "./locales";

export type Messages = typeof en;

/** A catalog with English's keys, any text: what every translation is. */
type Catalog = CatalogOf<Messages>;
type CatalogOf<T> = { [K in keyof T]: T[K] extends string ? string : CatalogOf<T[K]> };

/** Where translations are loaded from. See the module comment for the database variant. */
export interface MessageSource {
  load(locale: Locale): Promise<Messages>;
}

// `satisfies` makes every non-English catalog prove it has exactly English's shape (there
// are none today: add one here, as `xx: xx satisfies Catalog`).
const catalogs = { en } satisfies Record<Locale, Catalog>;

/** Messages shipped in this package. */
export const bundledMessages: MessageSource = {
  load: async (locale) => catalogs[locale],
};

export type Translator = ReturnType<typeof createTranslator<Messages>>;

/**
 * Server-side i18n over a message source, with a per-locale cache.
 *
 *   const i18n = createI18n(bundledMessages);
 *   const t = await i18n.getTranslator("en");
 *   t("email.otp.expires", { minutes: 5 }); // "This code expires in 5 minutes."
 */
export function createI18n(source: MessageSource) {
  const cache = new Map<Locale, Promise<Messages>>();

  const messagesFor = (locale: Locale) => {
    let pending = cache.get(locale);
    if (!pending) {
      pending = source.load(locale);
      // A failed load must not poison the cache; the next call retries.
      pending.catch(() => cache.delete(locale));
      cache.set(locale, pending);
    }
    return pending;
  };

  return {
    async getTranslator(locale: Locale, timeZone = "UTC"): Promise<Translator> {
      return createTranslator({ locale, messages: await messagesFor(locale), timeZone });
    },
    messages: messagesFor,
    /** Drop cached messages, e.g. after copy is edited in a database-backed source. */
    invalidate(locale?: Locale) {
      if (locale) {
        cache.delete(locale);
      } else {
        cache.clear();
      }
    },
  };
}

export type I18n = ReturnType<typeof createI18n>;
