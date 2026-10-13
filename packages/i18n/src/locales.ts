/**
 * The supported languages and how one is picked, without the catalogs: what client
 * components (a language menu, a preference check) need, at no bundle cost. The
 * package's index re-exports all of it.
 */
export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
const defaultLocale: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/** The locale to use for a stored value: itself when supported, else the default. */
export const localeOrDefault = (value: unknown): Locale =>
  isLocale(value) ? value : defaultLocale;

/** Whether `value` is a time zone this runtime knows ("Europe/Lisbon", "UTC"). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value === "") {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone to use for a stored value: itself when valid, else UTC. Accounts are
 * validated on the way in, but a row written another way mustn't make every date
 * formatting (or a job) throw.
 */
export const timeZoneOrUtc = (value: unknown): string => (isTimeZone(value) ? value : "UTC");

/**
 * Picks the best supported locale from an `Accept-Language` header or a list of
 * preferences (`["es-MX", "en"]`), falling back to the default.
 */
export function negotiateLocale(
  preferences: string | readonly string[] | null | undefined,
): Locale {
  const list =
    typeof preferences === "string"
      ? preferences
          .split(",")
          .map((part) => part.replace(/;.*/, "").trim())
          .filter(Boolean)
      : (preferences ?? []);
  for (const tag of list) {
    if (isLocale(tag)) {
      return tag;
    }
    const base = tag.split("-")[0];
    if (isLocale(base)) {
      return base;
    }
  }
  return defaultLocale;
}
