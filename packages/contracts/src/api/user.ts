import * as z from "zod";
import { fileIdSchema, orgIdSchema, userIdSchema } from "../ids";
import { base, EVERYDAY_WRITES, errorsOf } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf(
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
});

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Account"], summary });

export const userContract = {
  me: route("GET", "/me", "The signed-in user").output(meSchema),
  /** A ready avatar upload of the user's (FILE_NOT_READY otherwise), or null to remove it. */
  setAvatar: route("POST", "/me/avatar", "Set or remove the profile picture")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ fileId: fileIdSchema.nullable() }))
    .output(meSchema),
};
