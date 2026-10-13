import { Tabs } from "expo-router";
import { ListTodo, Settings } from "lucide-react-native";
import { useTranslations } from "use-intl";

/** The signed-in app (for users with a session: see the root layout's protected routes). */
export default function AppLayout() {
  const t = useTranslations("mobile.tabs");
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen
        name="index"
        options={{ title: t("todos"), tabBarIcon: ({ color }) => <ListTodo color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: t("settings"), tabBarIcon: ({ color }) => <Settings color={color} /> }}
      />
    </Tabs>
  );
}
