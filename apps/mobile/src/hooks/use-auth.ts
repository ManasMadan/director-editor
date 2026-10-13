/**
 * The shared auth form rules and error sentences (packages/client auth/forms) with this
 * app's translations.
 */
import { authErrorKey } from "@repo/client/auth/errors";
import { authFormSchemas } from "@repo/client/auth/forms";
import { loosely } from "@repo/i18n";
import { useTranslations } from "use-intl";

export function useAuthSchemas() {
  return authFormSchemas(loosely(useTranslations("validation")));
}

export function useAuthErrorMessage() {
  const t = useTranslations("authErrors");
  return (error: unknown) => {
    const key = authErrorKey(error);
    return t(key ?? "generic");
  };
}
