/** Sample props for the React Email preview server. */
import { bundledMessages, createI18n } from "@repo/i18n";
import OrgInvitationEmail, { type OrgInvitationEmailProps } from "../templates/org-invitation";

const props = {
  locale: "en",
  t: await createI18n(bundledMessages).getTranslator("en"),
  organizationName: "Acme",
  inviterName: "Ada",
  acceptUrl: "http://localhost:3000/invitations/accept?id=123",
  expiresInDays: 7,
} satisfies OrgInvitationEmailProps;

export default function Preview() {
  return <OrgInvitationEmail {...props} />;
}
