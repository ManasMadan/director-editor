/** A screen's frame: safe areas, keyboard avoidance and scrolling, with an optional title. */
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "@/components/ui/text";

export function Screen({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView className="flex-1" behavior={Platform.select({ ios: "padding" })}>
        <ScrollView contentContainerClassName="gap-6 p-6" keyboardShouldPersistTaps="handled">
          {title ? (
            <View className="gap-1">
              <Text role="heading" variant="h3">
                {title}
              </Text>
              {description ? <Text className="text-muted-foreground">{description}</Text> : null}
            </View>
          ) : null}
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
