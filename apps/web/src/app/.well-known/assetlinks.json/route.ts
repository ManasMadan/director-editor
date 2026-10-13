/** Android's association file for the mobile app (src/lib/app-links.ts). */
import { assetLinks } from "@/lib/app-links";

// Read per request, so one image serves each environment's app.
export const dynamic = "force-dynamic";

export function GET() {
  return assetLinks();
}
