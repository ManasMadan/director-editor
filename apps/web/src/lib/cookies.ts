/** Preference cookies read by the server render (src/i18n/request.ts). Not sensitive. */
import { DAY_S } from "@repo/contracts/time";

const YEAR = 365 * DAY_S;

export function setPreferenceCookie(name: "locale" | "tz", value: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is not available in every browser yet.
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${YEAR}; SameSite=Lax`;
}
