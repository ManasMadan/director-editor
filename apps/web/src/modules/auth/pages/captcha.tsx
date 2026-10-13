"use client";

import { buttonVariants } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useCaptcha } from "@/components/captcha";
import { AuthCard } from "../components/auth-card";
import { useCaptchaReturn } from "../hooks/use-captcha-return";

/**
 * The security check for the mobile app, which can't render Turnstile itself: the app
 * opens this page in the system's browser sheet with `?return_to=boilerplate://captcha-done`,
 * and once the check passes the page sends the browser there with `?token=`, which the
 * app hands to the API like the web forms do (apps/mobile/src/lib/captcha.ts). Works
 * signed out.
 */
export function CaptchaPage() {
  const t = useTranslations("captcha");
  const captcha = useCaptcha();
  const returnTo = useCaptchaReturn();
  let back: string | null = null;
  if (returnTo && captcha.token) {
    const url = new URL(returnTo);
    url.searchParams.set("token", captcha.token);
    back = url.href;
  }

  useEffect(() => {
    if (back) {
      window.location.replace(back);
    }
  }, [back]);

  return (
    <AuthCard title={t("title")} description={t("description")}>
      {returnTo === null ? (
        <p role="alert" className="text-sm text-destructive">
          {t("invalidReturn")}
        </p>
      ) : (
        captcha.widget
      )}
      {/* In case the browser holds back a redirect into the app it didn't see a tap for. */}
      {back ? (
        <a href={back} className={buttonVariants({ className: "mt-4 w-full" })}>
          {t("backToApp")}
        </a>
      ) : null}
    </AuthCard>
  );
}
