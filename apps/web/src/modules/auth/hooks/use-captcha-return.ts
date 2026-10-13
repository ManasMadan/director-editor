"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/** The mobile app's URL scheme (`scheme` in apps/mobile/app.config.ts). */
const APP_SCHEME = "boilerplate:";

/**
 * Where the captcha page may send its token: back into the mobile app (its scheme), or to
 * this origin, which serves the app's web build in the end-to-end run. Anything else is
 * refused, so the page can't be used to send people, or tokens, to another site.
 */
export function captchaReturnUrl(returnTo: string | null, origin: string): URL | null {
  const url = returnTo ? URL.parse(returnTo) : null;
  return url && (url.protocol === APP_SCHEME || url.origin === origin) ? url : null;
}

/**
 * The page's `?return_to=`, validated; undefined until the page runs in the browser (the
 * server doesn't know the origin the browser sees).
 */
export function useCaptchaReturn(): URL | null | undefined {
  const returnTo = useSearchParams().get("return_to");
  const [origin, setOrigin] = useState<string>();
  useEffect(() => setOrigin(window.location.origin), []);
  return origin === undefined ? undefined : captchaReturnUrl(returnTo, origin);
}
