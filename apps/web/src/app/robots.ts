import type { MetadataRoute } from "next";

import { env } from "@/env";

// Rendered per request, not at build time, so one image serves any environment's origin.
export const dynamic = "force-dynamic";

// Signed-in pages and auth flows are useless to crawlers; keep them out of the index.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/dashboard",
        "/settings",
        "/invitations",
        "/sign-",
        "/verify-email",
        "/forgot-password",
        "/reset-password",
        "/two-factor",
      ],
    },
    sitemap: `${env.WEB_URL}/sitemap.xml`,
  };
}
