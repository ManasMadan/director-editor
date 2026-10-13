/**
 * What the sign-in forms of every app share: the validation rules (from
 * packages/contracts, the same ones the API enforces). Apps pass their translator
 * (next-intl on web, use-intl on mobile). Which sentence an auth failure shows is in
 * ./errors.ts, which doesn't load the schemas.
 */
import {
  emailSchema,
  nameSchema,
  otpSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  phoneNumberSchema,
} from "@repo/contracts/auth";
import * as z from "zod";

/** The `validation.*` messages the schemas use. */
export type ValidationTranslator = (
  key: "email" | "passwordMin" | "passwordMax" | "required" | "nameMin" | "code" | "phone",
  values?: Record<string, number>,
) => string;

const matches = (schema: z.ZodType) => (value: string) => schema.safeParse(value).success;

export function authFormSchemas(t: ValidationTranslator) {
  return {
    email: z.string().trim().refine(matches(emailSchema), t("email")),
    /** For choosing a password: the server's length limits. */
    newPassword: z
      .string()
      .min(PASSWORD_MIN_LENGTH, t("passwordMin", { min: PASSWORD_MIN_LENGTH }))
      .max(PASSWORD_MAX_LENGTH, t("passwordMax", { max: PASSWORD_MAX_LENGTH })),
    /** For entering an existing password: only non-empty (never hint at the rules). */
    password: z.string().min(1, t("required")),
    name: z.string().refine(matches(nameSchema), t("nameMin")),
    otp: z.string().refine(matches(otpSchema), t("code")),
    /** E.164, typed with or without spaces and dashes. */
    phone: z.string().refine(matches(phoneNumberSchema), t("phone")),
  };
}
