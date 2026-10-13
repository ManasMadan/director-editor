/**
 * Sample props for the React Email preview server (`bun run --filter @repo/email dev`).
 * Kept out of the template module so production code never runs preview setup.
 */
import { bundledMessages, createI18n } from "@repo/i18n";
import AuthOtpEmail, { type AuthOtpEmailProps } from "../templates/auth-otp";

const props = {
  locale: "en",
  t: await createI18n(bundledMessages).getTranslator("en"),
  otp: "123456",
  purpose: "email-verification",
  expiresInMinutes: 5,
} satisfies AuthOtpEmailProps;

export default function Preview() {
  return <AuthOtpEmail {...props} />;
}
