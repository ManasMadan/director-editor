import { Button, Heading, Text } from "@react-email/components";
import { Layout, type LocalizedProps } from "./layout";

export interface WebhookDisabledEmailProps extends LocalizedProps {
  url: string;
  settingsUrl: string;
}

export const webhookDisabledSubject = ({ t, url }: WebhookDisabledEmailProps) =>
  t("email.webhookDisabled.subject", { url });

export default function WebhookDisabledEmail({
  locale,
  t,
  url,
  settingsUrl,
  unsubscribeUrl,
}: WebhookDisabledEmailProps) {
  return (
    <Layout
      locale={locale}
      t={t}
      preview={t("email.webhookDisabled.subject", { url })}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading as="h1" style={{ fontSize: 22, margin: "0 0 12px" }}>
        {t("email.webhookDisabled.heading")}
      </Heading>
      <Text style={{ color: "#444", fontSize: 15 }}>
        {t("email.webhookDisabled.body", { url })}
      </Text>
      <Button
        href={settingsUrl}
        style={{
          background: "#111",
          borderRadius: 6,
          color: "#fff",
          fontSize: 15,
          padding: "10px 18px",
        }}
      >
        {t("email.webhookDisabled.cta")}
      </Button>
    </Layout>
  );
}
