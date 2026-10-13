/**
 * Runs once when the server starts (never during the build): a half-configured mobile
 * app (some of its variables set, not all) stops the server here rather than on the
 * first request for its association files (src/lib/app-links.ts).
 */
import { mobileApp } from "@/lib/app-links";

export function register() {
  mobileApp();
}
