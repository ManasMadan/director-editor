"use client";

/**
 * Cloudflare Turnstile, only when the API has captcha on (`system.info.captchaSiteKey`).
 *
 *   const captcha = useCaptcha();
 *   ...{captcha.widget}
 *   await authClient.signUp.email(values, { headers: captcha.headers() });
 *   captcha.reset(); // tokens are single-use
 *
 * With captcha off, `widget` is null, `ready` is true once that's known and `headers()`
 * is empty, so forms are written once for both setups. The script loads from Cloudflare under the page's
 * nonce CSP ('strict-dynamic' trusts scripts our own bundle adds).
 */
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile failed to load"));
    script.onerror = () => {
      loading = undefined;
      reject(new Error("Turnstile failed to load"));
    };
    document.head.append(script);
  });
  return loading;
}

export interface Captcha {
  /** The widget to place in the form, or null when captcha is off. */
  widget: ReactNode;
  /** True once a submit can go through (as soon as the page knows, when captcha is off). */
  ready: boolean;
  /** The widget's current token, or null (none yet, expired, or captcha off). */
  token: string | null;
  /** Headers carrying the token, for better-auth's captcha plugin. */
  headers(): Record<string, string>;
  /** Get a fresh token after a submit: each one is valid once. */
  reset(): void;
}

export function useCaptcha(): Captcha {
  const { data: system } = useSystemInfoQuery();
  const siteKey = system?.captchaSiteKey ?? null;
  const locale = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const t = useTranslations("common");

  useEffect(() => {
    const element = container.current;
    if (!siteKey || !element) {
      return;
    }
    let cancelled = false;
    let turnstile: TurnstileApi | undefined;
    setFailed(false);
    loadTurnstile().then(
      (api) => {
        if (cancelled) {
          return;
        }
        turnstile = api;
        widgetId.current = api.render(element, {
          sitekey: siteKey,
          language: locale,
          callback: (value: string) => setToken(value),
          "expired-callback": () => setToken(null),
          "error-callback": () => setToken(null),
        });
      },
      // Blocked by an extension or offline: say so instead of leaving the form stuck.
      () => {
        if (!cancelled) {
          setFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
      if (turnstile && widgetId.current) {
        turnstile.remove(widgetId.current);
      }
      widgetId.current = undefined;
    };
  }, [siteKey, locale]);

  const reset = useCallback(() => {
    setToken(null);
    if (widgetId.current) {
      window.turnstile?.reset(widgetId.current);
    }
  }, []);

  return {
    widget: siteKey ? (
      <div>
        <div ref={container} data-testid="captcha" />
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {t("captchaFailed")}
          </p>
        ) : null}
      </div>
    ) : null,
    // Until system.info answers, a submit might lack the token the API then requires.
    ready: system !== undefined && (!siteKey || token !== null),
    token,
    headers: (): Record<string, string> =>
      siteKey && token ? { "x-captcha-response": token } : {},
    reset,
  };
}
