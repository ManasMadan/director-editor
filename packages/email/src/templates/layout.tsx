import { Body, Container, Head, Hr, Html, Preview, Section, Text } from "@react-email/components";
import type { Locale, Translator } from "@repo/i18n";
import type { ReactNode } from "react";

const brand = { name: "Director", color: "#171717" };

/** Every template receives the recipient's locale and a translator for it. */
export interface LocalizedProps {
  locale: Locale;
  t: Translator;
}

/** Shared chrome for every email. Keep it table-safe: React Email compiles to email-client HTML. */
export function Layout({
  locale,
  t,
  preview,
  children,
}: LocalizedProps & { preview: string; children: ReactNode }) {
  return (
    <Html lang={locale}>
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: "#f6f6f6",
          fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        <Container
          style={{
            backgroundColor: "#ffffff",
            borderRadius: 8,
            margin: "40px auto",
            maxWidth: 480,
            padding: 32,
          }}
        >
          <Text style={{ color: brand.color, fontSize: 18, fontWeight: 600, margin: 0 }}>
            {brand.name}
          </Text>
          <Section style={{ marginTop: 24 }}>{children}</Section>
          <Hr style={{ borderColor: "#eaeaea", marginTop: 32 }} />
          <Text style={{ color: "#8a8a8a", fontSize: 12 }}>
            {t("email.footer", { appName: brand.name })}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
