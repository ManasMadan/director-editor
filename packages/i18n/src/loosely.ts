/**
 * `loosely`, apart from the catalogs: the package's entry imports every language's
 * messages for the servers, and a client component that imported `loosely` from there
 * would ship all of them in its page's JavaScript. Pages and the client package import it
 * from `@repo/i18n/loosely` instead.
 */

/**
 * `t` for a key known only at run time (an error code, a notification or audit event)
 * whose arguments arrive with it. The compiler can't pair those, so the ICU test checks
 * every message's arguments against English instead. Everywhere else, call `t` itself.
 */
export type LooseTranslate = ((key: string, values?: Record<string, string | number>) => string) & {
  /** Whether the catalog has the key (a translator from `useTranslations` or `createTranslator`). */
  has(key: string): boolean;
};
// type-coverage:ignore-next-line
export const loosely = (t: object) => t as LooseTranslate;
