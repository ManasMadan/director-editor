/**
 * Auth rules shared by the API (apps/api/src/auth) and every client form, so the
 * browser rejects exactly what the server would.
 */
import * as z from "zod";
import { NAME_MAX_LENGTH, OTP_LENGTH, PHONE_CODE_LENGTH } from "./auth-settings";

export * from "./auth-settings";

/** An international phone number in E.164 form: "+" then country code and number. */
export const phoneNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replaceAll(/[\s().-]/g, ""))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/));
export const phoneCodeSchema = z.string().regex(new RegExp(`^\\d{${PHONE_CODE_LENGTH}}$`));

export const emailSchema = z.email().max(254).toLowerCase();
export const nameSchema = z.string().trim().min(1).max(NAME_MAX_LENGTH);
export const otpSchema = z.string().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`));
