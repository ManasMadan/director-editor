/**
 * Route groups the proxy and the client both need to agree on.
 * APP_PATHS need a session; GUEST_PATHS are pointless with one.
 */
export const APP_PATHS = [
  "/dashboard",
  "/settings",
  "/invitations",
  "/notifications",
  "/assistant",
  // Approving an app's OAuth request.
  "/oauth",
];
export const GUEST_PATHS = [
  "/sign-in",
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
];

/**
 * A page opened by an app's OAuth request carries it signed (client_id … sig). The
 * authorization server may send a signed-in user to sign in again (the app asked for
 * `prompt=login`), so auth pages stay reachable with one.
 */
export const isOAuthRequest = (params: URLSearchParams) =>
  params.has("client_id") && params.has("sig");

export const matchesPath = (pathname: string, prefixes: string[]) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
