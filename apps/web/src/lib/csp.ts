/**
 * The site's Content-Security-Policy, as src/proxy.ts sends it with every page. It lives
 * apart from the proxy so the browser tests can hold page code to the same rules: a
 * test page has no policy of its own, so code that the site's policy blocks (a `fetch()`
 * of a data: or blob: URL, say) would pass there and fail for every member.
 */
export function contentSecurityPolicy({
  nonce,
  development,
  storageOrigin,
}: {
  nonce: string;
  /** Development's hot reloading needs eval. */
  development: boolean;
  /** Where uploads go and files load from (presigned URLs), when files are on. */
  storageOrigin: string | undefined;
}): string[] {
  const storage = storageOrigin ? ` ${new URL(storageOrigin).origin}` : "";
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets Next's nonce'd bootstrap load its chunks; dev needs eval for
    // HMR.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https:${storage}`,
    "font-src 'self'",
    // Workers from this site only (none from elsewhere).
    "worker-src 'self'",
    // The API (and Director live's socket) is on this origin; Turnstile (captcha) needs
    // its origin when enabled.
    `connect-src 'self' https://challenges.cloudflare.com${storage}`,
    // Recorded takes play from blob: URLs, reviewed ones from storage.
    `media-src 'self' blob:${storage}`,
    // Shorts play in YouTube's privacy-enhanced embed.
    "frame-src https://challenges.cloudflare.com https://www.youtube-nocookie.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
}
