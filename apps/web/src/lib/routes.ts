/**
 * Route groups the proxy and the client both need to agree on.
 * APP_PATHS need a session; GUEST_PATHS are pointless with one.
 */
export const APP_PATHS = [
  "/settings",
  // Director: the library of Shorts to film, and filming one.
  "/library",
  "/shorts",
  "/saved",
  "/director",
];

/**
 * Full-screen pages that bring their own chrome (the YouTube-style feed and Director's
 * camera), so the site header and the page column stay out of their way.
 */
export const IMMERSIVE_PATHS = ["/library", "/shorts", "/saved", "/director"];

/** Where a signed-in person lands: after signing in, and from the site's own links. */
export const HOME_PATH = "/library";
export const GUEST_PATHS = [
  "/sign-in",
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
];

export const matchesPath = (pathname: string, prefixes: string[]) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
