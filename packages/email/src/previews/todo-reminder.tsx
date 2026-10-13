/**
 * Sample props for the React Email preview server (`bun run --filter @repo/email dev`).
 * Kept out of the template module so production code never runs preview setup.
 */
import { bundledMessages, createI18n } from "@repo/i18n";
import TodoReminderEmail, { type TodoReminderEmailProps } from "../templates/todo-reminder";

const props = {
  locale: "en",
  t: await createI18n(bundledMessages).getTranslator("en"),
  name: "Ada",
  title: "Ship the demo",
} satisfies TodoReminderEmailProps;

export default function Preview() {
  return <TodoReminderEmail {...props} />;
}
