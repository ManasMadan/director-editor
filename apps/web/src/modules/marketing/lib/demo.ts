import type { Route } from "next";

/**
 * Where "Try it now, no sign-up" goes: the sign-in page with `?demo=1`, which signs the
 * browser straight in to the demo (a guest of its own, or the shared account when guests
 * are off) and goes on to the library.
 */
export const DEMO_PATH: Route = "/sign-in?demo=1";

/** The demo, opening one template once the browser is in. */
export const demoPathTo = (videoId: string): Route =>
  `/sign-in?demo=1&next=${encodeURIComponent(`/director/${videoId}`)}`;
