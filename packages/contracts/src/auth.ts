/**
 * Auth rules shared by the API (apps/api/src/auth) and every client form, so the
 * browser rejects exactly what the server would.
 */
import * as z from "zod";
import { NAME_MAX_LENGTH, OTP_LENGTH } from "./auth-settings";

export * from "./auth-settings";

export const emailSchema = z.email().max(254).toLowerCase();
export const nameSchema = z.string().trim().min(1).max(NAME_MAX_LENGTH);
export const otpSchema = z.string().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`));
