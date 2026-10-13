/**
 * Refuses endpoint URLs that could make our servers call internal systems (SSRF): the
 * host must resolve only to public addresses, and production requires https. This check
 * gives the admin an immediate answer; apps/webhooks checks again on every delivery,
 * since DNS can change after this.
 */

import { fieldOf } from "@repo/contracts/objects";
import { AppError, isAppError, resolvePermitted } from "@repo/nest-common";
import { env } from "../../env";

export async function assertDeliverableUrl(raw: string) {
  const url = new URL(raw);
  if (env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new AppError("WEBHOOK_URL_NOT_ALLOWED");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  await resolvePermitted(host, env.WEBHOOK_ALLOWED_PRIVATE_ADDRESSES).catch((error: unknown) => {
    // A private address, or no such host, is the admin's to fix; DNS failing is ours,
    // and worth a retry.
    const code = fieldOf(error, "code");
    if (isAppError(error) || code === "ENOTFOUND" || code === "ENODATA") {
      throw new AppError("WEBHOOK_URL_NOT_ALLOWED");
    }
    throw new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "dns" }, cause: error });
  });
}
