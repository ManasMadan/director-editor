/**
 * Translated page titles:
 *
 *   export const generateMetadata = pageTitle("settings.title");
 */

import { loosely } from "@repo/i18n";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

type MessageKey = Parameters<Awaited<ReturnType<typeof getTranslations<never>>>>[0];

export const pageTitle = (key: MessageKey) => async (): Promise<Metadata> => ({
  title: loosely(await getTranslations())(key),
});
