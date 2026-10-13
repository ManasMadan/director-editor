"use client";

/**
 * Typed form fields: react-hook-form + shadcn Field, wired once so forms stay short.
 *
 *   <TextField control={form.control} name="email" label={t("common.email")} type="email" />
 *
 * `name` only accepts keys of the form's values, and the error message, aria-invalid and
 * label association are handled here. Ids come from useId, so two forms on one page
 * (e.g. two "confirm your password" fields) never share one.
 */
import { OTP_LENGTH } from "@repo/contracts/auth-settings";
import { Field, FieldError, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@repo/ui/components/input-otp";
import { type ComponentProps, type ReactNode, useId } from "react";
import { type Control, Controller, type FieldPath, type FieldValues } from "react-hook-form";

interface BaseProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: ReactNode;
}

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  ...input
}: BaseProps<T> & Omit<ComponentProps<typeof Input>, "name">) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input id={id} aria-invalid={fieldState.invalid} {...input} {...field} />
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  );
}

export function OtpField<T extends FieldValues>({ control, name, label }: BaseProps<T>) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <InputOTP
            id={id}
            maxLength={OTP_LENGTH}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-invalid={fieldState.invalid}
            {...field}
          >
            <InputOTPGroup>
              {Array.from({ length: OTP_LENGTH }, (_, index) => (
                <InputOTPSlot key={index} index={index} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  );
}
