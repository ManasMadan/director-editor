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
  // Director: the Shorts feed and filming one.
  "/home",
  "/shorts",
  "/saved",
  "/director",
];

/**
 * Full-screen pages that bring their own chrome (the YouTube-style feed and Director's
 * camera), so the site header and the page column stay out of their way.
 */
export const IMMERSIVE_PATHS = ["/home", "/shorts", "/saved", "/director"];
export const GUEST_PATHS = [
  "/sign-in",
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
];

export const matchesPath = (pathname: string, prefixes: string[]) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
