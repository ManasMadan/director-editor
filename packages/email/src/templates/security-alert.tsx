import { Button, Heading, Text } from "@react-email/components";
import { Layout, type LocalizedProps } from "./layout";

type SecurityEventName =
  | "email-changed"
  | "password-changed"
  | "password-reset"
  | "two-factor-enabled"
  | "two-factor-disabled"
  | "passkey-added"
  | "phone-added"
  | "phone-removed"
  | "app-connected"
  | "api-key-created"
  | "webhook-endpoint-created";

export interface SecurityAlertEmailProps extends LocalizedProps {
  event: SecurityEventName;
  newEmail?: string | undefined;
  /** What was created: an API key's name or a webhook endpoint's URL. */
  label?: string | undefined;
  securityUrl: string;
}

export const securityAlertSubject = ({ t, event }: SecurityAlertEmailProps) =>
  t(`email.securityAlert.${event}.subject`);

/** "Something changed on your account": the owner hears about every sensitive change. */
export default function SecurityAlertEmail({
  locale,
  t,
  event,
  newEmail,
  label,
  securityUrl,
}: SecurityAlertEmailProps) {
  return (
    <Layout locale={locale} t={t} preview={t(`email.securityAlert.${event}.subject`)}>
      <Heading as="h1" style={{ fontSize: 22, margin: "0 0 12px" }}>
        {t(`email.securityAlert.${event}.subject`)}
      </Heading>
      <Text style={{ color: "#444", fontSize: 15 }}>
        {t(`email.securityAlert.${event}.body`, { newEmail: newEmail ?? "", label: label ?? "" })}
      </Text>
      <Text style={{ color: "#444", fontSize: 15 }}>{t("email.securityAlert.notYou")}</Text>
      <Button
        href={securityUrl}
        style={{
          background: "#111",
          borderRadius: 6,
          color: "#fff",
          fontSize: 15,
          padding: "10px 18px",
        }}
      >
        {t("email.securityAlert.cta")}
      </Button>
    </Layout>
  );
}
