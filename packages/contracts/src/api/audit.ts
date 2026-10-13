/** The organization's audit log (owners and admins only). */
import * as z from "zod";
import { userIdSchema } from "../ids";
import { page, pageInput } from "../pagination";
import { base, errorsOf, WORKSPACE_ERRORS } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf(...WORKSPACE_ERRORS, "API_KEY_SCOPE_MISSING");

export const auditEntrySchema = z.object({
  id: z.uuid(),
  /**
   * Versioned event name; the client translates it for display. A string, not the known
   * names: the log may hold an event newer than this build (see eventEnvelope).
   */
  name: z.string(),
  occurredAt: z.date(),
  /** Who did it; null for system actions or deleted accounts. */
  actor: z.object({ id: userIdSchema, name: z.string(), email: z.email() }).nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditContract = {
  list: base
    .errors(errors)
    .meta({ apiKeyScope: "audit:read" })
    .route({
      method: "GET",
      path: "/audit",
      tags: ["Audit"],
      summary: "The active organization's audit log, newest first",
    })
    .input(pageInput)
    .output(page(auditEntrySchema)),
};
