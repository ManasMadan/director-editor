import type { ReactNode } from "react";
import { Suspense } from "react";

// Auth screens read the query string (?next=, ?email=), which requires a Suspense
// boundary so the rest of the page can still be prerendered.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <Suspense>{children}</Suspense>;
}
