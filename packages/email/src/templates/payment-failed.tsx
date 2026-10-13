import { Button, Heading, Text } from "@react-email/components";
import { Layout, type LocalizedProps } from "./layout";

export interface PaymentFailedEmailProps extends LocalizedProps {
  organizationName: string;
  /** Already formatted in the recipient's locale, e.g. "$36.00". */
  amount: string;
  billingUrl: string;
}

export const paymentFailedSubject = ({ t, organizationName }: PaymentFailedEmailProps) =>
  t("email.paymentFailed.subject", { organizationName });

/** A renewal didn't go through; Stripe retries, but the card needs fixing. */
export default function PaymentFailedEmail({
  locale,
  t,
  organizationName,
  amount,
  billingUrl,
}: PaymentFailedEmailProps) {
  return (
    <Layout locale={locale} t={t} preview={t("email.paymentFailed.subject", { organizationName })}>
      <Heading as="h1" style={{ fontSize: 22, margin: "0 0 12px" }}>
        {t("email.paymentFailed.heading")}
      </Heading>
      <Text style={{ color: "#444", fontSize: 15 }}>
        {t("email.paymentFailed.body", { organizationName, amount })}
      </Text>
      <Button
        href={billingUrl}
        style={{
          background: "#111",
          borderRadius: 6,
          color: "#fff",
          fontSize: 15,
          padding: "10px 18px",
        }}
      >
        {t("email.paymentFailed.cta")}
      </Button>
    </Layout>
  );
}
