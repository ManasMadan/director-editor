/**
 * Cloudflare Turnstile, when the API has captcha on (`system.info.captchaSiteKey`): the
 * API wants a token on sign-up and on every emailed code, and the widget only runs in a
 * web page. So the app opens the site's /captcha page (apps/web) in the system's browser
 * sheet, which sends the browser back to `boilerplate://captcha-done?token=…` once the check
 * passes; the token goes in the header the web forms send it in.
 *
 *   const captcha = useCaptcha();
 *   const headers = await captcha();
 *   if (!headers) { ...the person closed the check }
 *   await authClient.signUp.email({ ...values, fetchOptions: { headers } });
 *
 * With captcha off the headers are empty and nothing opens. On the web build the sheet is
 * a popup, and the page it comes back to hands the URL over in the root layout
 * (`maybeCompleteAuthSession`).
 */
import { useApi } from "@repo/client";
import { useQueryClient } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { apiUrl } from "./config";

/** Where the captcha page sends the token: the app's scheme (this origin, on the web). */
export const captchaReturnUrl = () => Linking.createURL("captcha-done");

export function useCaptcha() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return async (): Promise<Record<string, string> | null> => {
    const system = await queryClient.ensureQueryData(api.system.info.queryOptions());
    if (!system.captchaSiteKey) {
      return {};
    }
    const returnTo = captchaReturnUrl();
    const page = `${apiUrl}/captcha?${new URLSearchParams({ return_to: returnTo })}`;
    const result = await WebBrowser.openAuthSessionAsync(page, returnTo);
    if (result.type !== "success") {
      return null;
    }
    const token = new URL(result.url).searchParams.get("token");
    return token ? { "x-captcha-response": token } : null;
  };
}
