"use client";

import { useLiveUpdates } from "@repo/client";
import { authClient } from "@/lib/auth-client";

/** Keeps what's on screen fresh as it changes elsewhere (other tabs, teammates). Renders nothing. */
export function LiveUpdates() {
  const { data: session } = authClient.useSession();
  useLiveUpdates(session?.session.activeOrganizationId);
  return null;
}
