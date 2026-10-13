import { Stack } from "expo-router";

/** Sign-in screens (for signed-out users: see the root layout's protected routes). */
export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
