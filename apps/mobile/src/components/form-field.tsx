/** A labelled text input bound to react-hook-form, showing its validation message. */
import { type ComponentProps, useId } from "react";
import { type Control, Controller, type FieldPath, type FieldValues } from "react-hook-form";
import { View } from "react-native";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/ui/text";

interface FormFieldProps<T extends FieldValues>
  extends Omit<ComponentProps<typeof Input>, "value" | "onChangeText" | "onBlur"> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
}

export function FormField<T extends FieldValues>({
  control,
  name,
  label,
  ...input
}: FormFieldProps<T>) {
  // Unique per field, not per name: on the web a screen stays mounted under the one pushed
  // over it, and a second field named the same would take the first one's label.
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <View className="gap-1.5">
          <Label nativeID={id}>{label}</Label>
          <Input
            aria-labelledby={id}
            accessibilityLabel={label}
            value={String(field.value ?? "")}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            aria-invalid={Boolean(fieldState.error)}
            {...input}
          />
          {fieldState.error?.message ? (
            <Text role="alert" className="text-sm text-destructive">
              {fieldState.error.message}
            </Text>
          ) : null}
        </View>
      )}
    />
  );
}
