/**
 * Translated page titles:
 *
 *   export const generateMetadata = pageTitle("settings.title");
 */

import type { Messages } from "@repo/i18n";
import { loosely } from "@repo/i18n/loosely";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

/** The catalog's messages directly under `T`, as `${prefix}key`. */
type Leaf<T, Prefix extends string> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : never;
}[keyof T & string];

/** The messages one namespace further down. */
type Nested<T, Prefix extends string> = {
  [K in keyof T & string]: T[K] extends string ? never : Leaf<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/**
 * A page title's key: a message one or two namespaces deep ("common.library",
 * "director.media.title"), which is where every title sits. next-intl's own key type
 * also works out each message's ICU arguments for the whole catalog, which TypeScript
 * gives up on ("excessively deep") once the catalog is this size; a title takes none.
 */
type TitleKey = {
  [A in keyof Messages & string]: Leaf<Messages[A], `${A}.`> | Nested<Messages[A], `${A}.`>;
}[keyof Messages & string];

export const pageTitle = (key: TitleKey) => async (): Promise<Metadata> => ({
  title: loosely(await getTranslations())(key),
});
