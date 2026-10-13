import { loosely } from "@repo/i18n";
import { useTranslations } from "use-intl";
import { errorMessageKey, errorParams } from "./errors";

/**
 * A translated sentence for any failed API call (never the server's English message).
 * Web's next-intl provider is use-intl's, so this reads the same messages on both apps.
 */
export function useApiErrorMessage() {
  const t = loosely(useTranslations());
  return (error: unknown) => t(errorMessageKey(error), errorParams(error));
}
