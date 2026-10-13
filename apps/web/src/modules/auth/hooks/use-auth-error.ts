"use client";

import { authErrorKey } from "@repo/client/auth/errors";
import { useTranslations } from "next-intl";

/**
 * A better-auth failure as a translated sentence (see authErrorKey in packages/client).
 * Codes without a sentence fall back to a generic one; add them to AUTH_ERROR_CODES in
 * packages/contracts (and `authErrors` in packages/i18n) when a new plugin introduces
 * codes users can hit.
 */
export function useAuthErrorMessage() {
  const t = useTranslations("authErrors");
  return (error: unknown) => {
    const key = authErrorKey(error);
    return t(key ?? "generic");
  };
}
