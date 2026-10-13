"use client";

import type { Route } from "next";
import { useSearchParams } from "next/navigation";
import * as z from "zod";

/** Where to go after signing in: the page that sent the user here, if it is ours. */
export function useNextPath(): Route {
  return safeNextPath(useSearchParams().get("next"));
}

const BASE = "https://same.site";

/**
 * Only paths on this site: "//evil.com", "/\\evil.com" or "https://…" would be an open
 * redirect. Resolving against a placeholder origin catches every spelling browsers accept.
 */
export function safeNextPath(next: string | null): Route {
  if (!next?.startsWith("/")) {
    return "/dashboard";
  }
  const url = new URL(next, BASE);
  return (url.origin === BASE ? url.pathname + url.search + url.hash : "/dashboard") as Route;
}

/**
 * A link to another auth step that keeps the query: `?next=`, and the signed OAuth
 * request when an app sent the user here (see use-finish-sign-in), so the step that
 * finally signs the user in still continues it. Optionally sets the email.
 */
export function useAuthStepHref() {
  const current = useSearchParams().toString();
  return (path: "/sign-in" | "/sign-up" | "/verify-email", email?: string): Route => {
    const params = new URLSearchParams(current);
    params.delete("email");
    if (email) {
      params.set("email", email);
    }
    const query = params.toString();
    return (query ? `${path}?${query}` : path) as Route;
  };
}

/** The `?email=` carried between auth steps, validated. */
export function useEmailParam(): string | null {
  const parsed = z.email().safeParse(useSearchParams().get("email"));
  return parsed.success ? parsed.data : null;
}
