"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { IMMERSIVE_PATHS, matchesPath } from "@/lib/routes";

/**
 * The site header and the page column around every page, except the immersive ones
 * (IMMERSIVE_PATHS), which fill the screen with their own chrome. A client component, as
 * the root layout stays mounted across navigations and couldn't follow the path itself.
 */
export function SiteChrome({ header, children }: { header: ReactNode; children: ReactNode }) {
  // Null outside a navigation (a server render with no path): the usual chrome then.
  const pathname: string | null = usePathname();
  if (pathname !== null && matchesPath(pathname, IMMERSIVE_PATHS)) {
    return <main className="min-h-dvh bg-studio text-studio-foreground">{children}</main>;
  }
  return (
    <>
      {header}
      <main className="mx-auto w-full max-w-5xl px-4 py-10">{children}</main>
    </>
  );
}
