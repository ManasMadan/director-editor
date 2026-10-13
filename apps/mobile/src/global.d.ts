import type { Locale, Messages } from "@repo/i18n";

// Types `useTranslations()` against the shared English catalog: a wrong key, or a message
// called without the arguments it names, fails to compile (as on the web).
declare module "use-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
