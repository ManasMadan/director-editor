import { Heading, Text } from "@react-email/components";
import { Layout, type LocalizedProps } from "./layout";

type OtpPurpose = "sign-in" | "email-verification" | "forget-password" | "change-email";

export interface AuthOtpEmailProps extends LocalizedProps {
  otp: string;
  purpose: OtpPurpose;
  expiresInMinutes: number;
}

export const authOtpSubject = ({ t, purpose }: AuthOtpEmailProps) =>
  t(`email.otp.${purpose}.subject`);

export default function AuthOtpEmail({
  locale,
  t,
  otp,
  purpose,
  expiresInMinutes,
}: AuthOtpEmailProps) {
  return (
    <Layout locale={locale} t={t} preview={`${t(`email.otp.${purpose}.subject`)}: ${otp}`}>
      <Heading as="h1" style={{ fontSize: 22, margin: "0 0 12px" }}>
        {t(`email.otp.${purpose}.heading`)}
      </Heading>
      <Text style={{ color: "#444", fontSize: 15 }}>{t(`email.otp.${purpose}.body`)}</Text>
      <Text
        style={{
          fontFamily: "ui-monospace, Menlo, monospace",
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: 8,
          margin: "24px 0",
        }}
      >
        {otp}
      </Text>
      <Text style={{ color: "#8a8a8a", fontSize: 13 }}>
        {t("email.otp.expires", { minutes: expiresInMinutes })}
      </Text>
    </Layout>
  );
}
