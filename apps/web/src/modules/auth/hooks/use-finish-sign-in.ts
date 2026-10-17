"use client";

import { useRouter } from "next/navigation";
import { useNextPath } from "./use-next-path";

/** What to do once a request signed the user in: go on to `?next=` (or the library). */
export function useFinishSignIn() {
  const router = useRouter();
  const next = useNextPath();
  return () => {
    router.replace(next);
    router.refresh();
  };
}
