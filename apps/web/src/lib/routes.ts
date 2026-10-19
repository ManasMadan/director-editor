/**
 * Route groups the proxy and the client both need to agree on.
 * APP_PATHS need a session; GUEST_PATHS are pointless with one.
 */
export const APP_PATHS = [
  "/settings",
  // Director: the library of Shorts to film, and filming one. /shorts only redirects
  // old links to a short's page in Director.
  "/library",
  "/shorts",
  "/director",
  // Describing a template of your own, and changing its shots.
  "/create",
  // My media: the videos the member saved from the editor.
  "/media",
];

/**
 * Pages on Director's dark stage: the header and the page sit on it too, so the library's
 * thumbnails and the template's video read as they do on YouTube.
 */
export const STUDIO_PATHS = ["/library", "/media"];

/**
 * Full-screen pages that bring their own chrome (a short's page and Director's camera),
 * so the site header and the page column stay out of their way.
 */
export const IMMERSIVE_PATHS = ["/director", "/create"];

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

/**
 * Whether a page is one of Director's own (studio or immersive), on its dark stage whatever
 * the member's theme. Null outside a navigation (a server render with no path): no.
 */
export const onStage = (pathname: string | null) =>
  pathname !== null && matchesPath(pathname, [...STUDIO_PATHS, ...IMMERSIVE_PATHS]);
