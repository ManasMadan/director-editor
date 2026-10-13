/** Sample props for the React Email preview server. */
import { bundledMessages, createI18n } from "@repo/i18n";
import DigestEmail, { type DigestEmailProps } from "../templates/digest";

const props = {
  locale: "en",
  t: await createI18n(bundledMessages).getTranslator("en"),
  items: [
    { title: "Reminder", body: "Ship the demo" },
    { title: "A webhook endpoint was turned off", body: "https://example.com/hooks kept failing." },
  ],
  unsubscribeUrl: "http://localhost:3000/unsubscribe?token=preview",
} satisfies DigestEmailProps;

export default function Preview() {
  return <DigestEmail {...props} />;
}
