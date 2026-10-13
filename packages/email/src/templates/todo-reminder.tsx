import { Heading, Text } from "@react-email/components";
import { Layout, type LocalizedProps } from "./layout";

export interface TodoReminderEmailProps extends LocalizedProps {
  /** Left out of the greeting when there's none (never "Hi ,"). */
  name: string | null;
  title: string;
}

export const todoReminderSubject = ({ t, title }: TodoReminderEmailProps) =>
  t("email.todoReminder.subject", { title });

export default function TodoReminderEmail({
  locale,
  t,
  name,
  title,
  unsubscribeUrl,
}: TodoReminderEmailProps) {
  return (
    <Layout
      locale={locale}
      t={t}
      preview={t("email.todoReminder.subject", { title })}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading as="h1" style={{ fontSize: 22, margin: "0 0 12px" }}>
        {name ? t("email.todoReminder.greeting", { name }) : t("email.todoReminder.greetingNoName")}
      </Heading>
      <Text style={{ color: "#444", fontSize: 15 }}>{t("email.todoReminder.body", { title })}</Text>
    </Layout>
  );
}
