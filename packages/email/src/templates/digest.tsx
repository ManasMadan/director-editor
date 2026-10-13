import { Heading, Section, Text } from "@react-email/components";
import { Layout, type LocalizedProps } from "./layout";

export interface DigestEmailProps extends LocalizedProps {
  /** Already-translated lines, oldest first. */
  items: { title: string; body: string }[];
}

export const digestSubject = ({ t }: DigestEmailProps) => t("email.digest.subject");

/** One email summarising the day's non-urgent notifications (users opt in). */
export default function DigestEmail({ locale, t, items, unsubscribeUrl }: DigestEmailProps) {
  return (
    <Layout
      locale={locale}
      t={t}
      preview={t("email.digest.subject")}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading as="h1" style={{ fontSize: 22, margin: "0 0 12px" }}>
        {t("email.digest.heading")}
      </Heading>
      <Text style={{ color: "#444", fontSize: 15 }}>
        {t("email.digest.intro", { count: items.length })}
      </Text>
      {items.map((item, index) => (
        <Section key={index} style={{ borderTop: "1px solid #eaeaea", paddingTop: 12 }}>
          <Text style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{item.title}</Text>
          <Text style={{ color: "#444", fontSize: 14, margin: "4px 0 0" }}>{item.body}</Text>
        </Section>
      ))}
    </Layout>
  );
}
