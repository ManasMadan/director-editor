"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/components/button";
import { FieldGroup } from "@repo/ui/components/field";
import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { TextField } from "@/components/form-fields";
import { useAuthSchemas } from "@/modules/auth";

/**
 * "Enter your password to continue" for sensitive actions. `onConfirm` returns an error
 * message to show under the field, or nothing on success.
 */
export function PasswordConfirm({
  label,
  submit,
  variant = "default",
  onConfirm,
}: {
  label: ReactNode;
  submit: ReactNode;
  variant?: "default" | "destructive";
  onConfirm: (password: string) => Promise<string | undefined>;
}) {
  const schema = z.object({ password: useAuthSchemas().password });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { password: "" } });
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async ({ password }) => {
        const error = await onConfirm(password);
        if (error) {
          form.setError("password", { message: error });
        } else {
          form.reset();
        }
      })}
    >
      <FieldGroup>
        <TextField
          control={form.control}
          name="password"
          label={label}
          type="password"
          autoComplete="current-password"
        />
        <Button
          type="submit"
          variant={variant}
          className="self-start"
          disabled={form.formState.isSubmitting}
        >
          {submit}
        </Button>
      </FieldGroup>
    </form>
  );
}
