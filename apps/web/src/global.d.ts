import type { Locale, Messages } from "@repo/i18n";

// Types `useTranslations()` against the shared English catalog: a wrong key, or a message
// called without the arguments it names (or with the wrong kind), fails to compile. The
// catalog is typed with each message's literal text (packages/i18n/messages/en.d.json.ts).
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
