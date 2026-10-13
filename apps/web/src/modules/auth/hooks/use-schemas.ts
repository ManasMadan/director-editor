"use client";

import { authFormSchemas } from "@repo/client/auth/forms";
import { loosely } from "@repo/i18n";
import { useTranslations } from "next-intl";

/** The shared auth form schemas (packages/client) with messages in the user's language. */
export function useAuthSchemas() {
  return authFormSchemas(loosely(useTranslations("validation")));
}
