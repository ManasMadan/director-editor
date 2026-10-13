import type { MetadataRoute } from "next";

import { env } from "@/env";

// Rendered per request, not at build time, so one image serves any environment's origin.
export const dynamic = "force-dynamic";

// Public pages only. Add new marketing pages here.
export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/terms", "/privacy"].map((path) => ({
    url: new URL(path, env.WEB_URL).toString(),
  }));
}
