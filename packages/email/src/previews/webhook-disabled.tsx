/** Sample props for the React Email preview server. */
import { bundledMessages, createI18n } from "@repo/i18n";
import WebhookDisabledEmail, {
  type WebhookDisabledEmailProps,
} from "../templates/webhook-disabled";

const props = {
  locale: "en",
  t: await createI18n(bundledMessages).getTranslator("en"),
  url: "https://example.com/webhooks",
  settingsUrl: "http://localhost:3000/settings/webhooks",
  unsubscribeUrl: "http://localhost:3000/unsubscribe?token=preview",
} satisfies WebhookDisabledEmailProps;

export default function Preview() {
  return <WebhookDisabledEmail {...props} />;
}
