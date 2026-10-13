/**
 * Next.js configuration.
 *
 * The web app renders UI only (a hard rule, enforced by `bun run lint:boundaries`):
 * no route handlers with logic, no server actions, no database. Everything it shows
 * comes from apps/api through packages/client. It runs as a Node server
 * (`output: "standalone"`) so it can render public pages on the server, redirect
 * signed-out users before any HTML is sent, set a per-request CSP nonce, and serve
 * dynamic routes like /invitations/[id].
 *
 * The browser always calls the API on this site's own origin (/rpc, /api). In deployed
 * environments the gateway routes those paths to apps/api before they reach Next; in
 * local development the rewrites below forward them, so both setups behave the same
 * and cookies stay first-party.
 */
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { env } from "./src/env";

const config: NextConfig = {
  output: "standalone",
  // The build checks the app's own types only; tsconfig.build.json says why.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // Workspace packages ship TypeScript source; Next compiles them like app code.
  transpilePackages: ["@repo/ui", "@repo/client", "@repo/contracts", "@repo/i18n"],
  // `<Link href>` and `router.push()` only accept routes that exist.
  typedRoutes: true,
  // Automatic memoization: `useMemo`/`useCallback` are rarely needed.
  reactCompiler: true,
  poweredByHeader: false,
  // This repo's agent instructions live in CLAUDE.md (Next would otherwise write AGENTS.md).
  agentRules: false,
  async rewrites() {
    return [
      { source: "/rpc/:path*", destination: `${env.API_URL}/rpc/:path*` },
      { source: "/api/:path*", destination: `${env.API_URL}/api/:path*` },
      { source: "/docs", destination: `${env.API_URL}/docs` },
      // OAuth discovery for MCP clients: the authorization server (the api) and each MCP
      // server's protected-resource metadata.
      {
        source: "/.well-known/oauth-authorization-server/api/auth",
        destination: `${env.API_URL}/.well-known/oauth-authorization-server/api/auth`,
      },
      {
        source: "/.well-known/openid-configuration/api/auth",
        destination: `${env.API_URL}/.well-known/openid-configuration/api/auth`,
      },
      {
        source: "/.well-known/oauth-protected-resource/api/mcp",
        destination: `${env.API_URL}/.well-known/oauth-protected-resource/api/mcp`,
      },
      ...(env.AI_URL
        ? [
            { source: "/ai/mcp", destination: `${env.AI_URL}/ai/mcp` },
            {
              source: "/.well-known/oauth-protected-resource/ai/mcp",
              destination: `${env.AI_URL}/.well-known/oauth-protected-resource/ai/mcp`,
            },
          ]
        : []),
    ];
  },
  async headers() {
    // The Content-Security-Policy is set per request in src/proxy.ts (it needs a nonce).
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(config);
