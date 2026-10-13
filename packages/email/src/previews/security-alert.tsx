/** Sample props for the React Email preview server. */
import { bundledMessages, createI18n } from "@repo/i18n";
import SecurityAlertEmail, { type SecurityAlertEmailProps } from "../templates/security-alert";

const props = {
  locale: "en",
  t: await createI18n(bundledMessages).getTranslator("en"),
  event: "email-changed",
  newEmail: "ada@new.example",
  securityUrl: "http://localhost:3000/settings/security",
} satisfies SecurityAlertEmailProps;

export default function Preview() {
  return <SecurityAlertEmail {...props} />;
}
