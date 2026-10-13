"use client";

import { useRouter } from "next/navigation";
import { useNextPath } from "./use-next-path";

/**
 * What to do once a request signed the user in. On a page an app's OAuth request opened
 * (it carries the signed request in its URL), the answer is that authorization's next
 * step, `{ redirect: true, url }`, and the auth client is already navigating there;
 * otherwise the user goes on to `?next=` (or the dashboard).
 */
export function useFinishSignIn() {
  const router = useRouter();
  const next = useNextPath();
  return (data: unknown) => {
    if (isRedirect(data)) {
      return;
    }
    router.replace(next);
    router.refresh();
  };
}

const isRedirect = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "redirect" in data &&
  data.redirect === true &&
  "url" in data &&
  typeof data.url === "string";
