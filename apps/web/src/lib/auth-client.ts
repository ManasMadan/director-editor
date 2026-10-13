/** The web app's better-auth client (same origin; see packages/client/src/auth). */
import { createAppAuthClient } from "@repo/client/auth";

export const authClient = createAppAuthClient({
  // A sign-in that needs a second factor continues on the two-step page, keeping the
  // query (`?next=`, or the OAuth request an app sent the user here with).
  onTwoFactorRequired: () => window.location.assign(`/two-factor${window.location.search}`),
});
