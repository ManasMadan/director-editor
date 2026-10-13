import * as z from "zod";
import { phoneCodeSchema, phoneNumberSchema } from "../auth";
import { fileIdSchema, orgIdSchema, userIdSchema } from "../ids";
import { HOUR_S } from "../time";
import { base, EVERYDAY_WRITES, errorsOf } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf(
  "FRESH_SESSION_REQUIRED",
  "PHONE_CODE_INVALID",
  "PHONE_NUMBER_TAKEN",
  // Setting the picture checks the upload it names.
  "FEATURE_DISABLED",
  "FILE_NOT_FOUND",
  "FILE_NOT_READY",
);

const meSchema = z.object({
  id: userIdSchema,
  name: z.string(),
  email: z.email(),
  image: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
  activeOrganizationId: orgIdSchema.nullable(),
  /** Verified, E.164; null until the user adds one. */
  phoneNumber: z.string().nullable(),
});

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Account"], summary });

export const userContract = {
  me: route("GET", "/me", "The signed-in user").output(meSchema),
  /**
   * Texts a code to a number the user wants to add (or change to). Needs a recently
   * signed-in session (FRESH_SESSION_REQUIRED otherwise), and is limited per user and
   * per number (RATE_LIMITED); PhoneService counts per number, since that key is input.
   * Both refuse when Redis is down: without it, no texts go out.
   */
  sendPhoneCode: route("POST", "/me/phone/code", "Text a verification code")
    .meta({
      rateLimit: { name: "phone-code-user", points: 5, windowSeconds: HOUR_S, per: "user" },
    })
    .input(z.object({ phoneNumber: phoneNumberSchema }))
    .output(z.object({ expiresInSeconds: z.number().int() })),
  /** Saves the number once the texted code matches (PHONE_CODE_INVALID otherwise). */
  verifyPhone: route("POST", "/me/phone/verify", "Verify and save a phone number")
    .meta({
      rateLimit: { name: "phone-code-verify", points: 20, windowSeconds: HOUR_S, per: "user" },
    })
    .input(z.object({ phoneNumber: phoneNumberSchema, code: phoneCodeSchema }))
    .output(meSchema),
  removePhone: route("POST", "/me/phone/remove", "Remove the phone number")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .output(meSchema),
  /** A ready avatar upload of the user's (FILE_NOT_READY otherwise), or null to remove it. */
  setAvatar: route("POST", "/me/avatar", "Set or remove the profile picture")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ fileId: fileIdSchema.nullable() }))
    .output(meSchema),
};
