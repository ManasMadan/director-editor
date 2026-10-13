/**
 * Links the OS opens the app with. The captcha page's answer (`boilerplate://captcha-done?token=…`)
 * is read by the browser session that asked for it (lib/captcha.ts), but Android also
 * hands it to the app as a link: there it isn't a screen to open over the form waiting
 * for the token.
 */
import { captchaReturnUrl } from "@/lib/captcha";

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (!path.startsWith(captchaReturnUrl())) {
    return path;
  }
  // A cold start from it (the app was closed meanwhile) opens the app as usual.
  return initial ? "/" : null;
}
