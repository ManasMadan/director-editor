/**
 * Liveness/readiness probe for Kubernetes. The only route handler allowed in the web app
 * (see scripts/check-web-render-only.ts): it answers without touching the API, so a slow
 * API never restarts healthy web pods.
 */
export const dynamic = "force-static";

export function GET() {
  return Response.json({ status: "ok" });
}
