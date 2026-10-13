/**
 * Apps connected to the user's workspaces over OAuth (MCP clients such as Claude or an
 * IDE), and disconnecting them. One entry per app and workspace the user approved.
 */
import * as z from "zod";
import { orgIdSchema } from "../ids";
import { base, EVERYDAY_WRITES, errorsOf } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf("APP_NOT_FOUND");

const connectedAppSchema = z.object({
  /** The approval (one per app and workspace). */
  id: z.uuid(),
  clientId: z.string(),
  /** As the app registered itself: shown, but not verified. */
  name: z.string().nullable(),
  uri: z.string().nullable(),
  workspace: z.object({ id: orgIdSchema, name: z.string() }),
  scopes: z.array(z.string()),
  connectedAt: z.date(),
  /** When the app last renewed its access (a refresh token); null if it never has. */
  lastUsedAt: z.date().nullable(),
});
export type ConnectedApp = z.infer<typeof connectedAppSchema>;

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Account"], summary });

export const appsContract = {
  list: route("GET", "/me/apps", "Apps connected to your workspaces").output(
    z.array(connectedAppSchema),
  ),
  /**
   * Revokes the approval and every token issued under it; the app loses access at once
   * (APP_NOT_FOUND for an id that isn't the user's).
   */
  disconnect: route("POST", "/me/apps/{id}/disconnect", "Disconnect an app")
    .meta({ rateLimit: EVERYDAY_WRITES })
    .input(z.object({ id: z.uuid() }))
    .output(z.void()),
};
