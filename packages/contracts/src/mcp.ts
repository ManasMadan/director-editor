/**
 * MCP (Model Context Protocol) access: which servers exist, where they live, and what an
 * MCP client may ask to do.
 *
 * Both servers sit on the site's own origin, next to the web app, so their resource
 * identifiers (RFC 8707) are stable public URLs: the gateway routes each path to its
 * service (in local development, the web app's rewrites do). The api is the OAuth
 * authorization server for both; tokens are audience-bound to one of these resources and
 * carry the workspace the user chose on the consent page.
 */

/** The api's MCP server (workspace data: todos). */
export const MCP_PATH = "/api/mcp";
/** The Python service's MCP server (the workspace's documents). */
export const AI_MCP_PATH = "/ai/mcp";

/** The resource identifier of an MCP server on a site's origin (no trailing slash). */
export const mcpResource = (siteUrl: string, path: typeof MCP_PATH | typeof AI_MCP_PATH) =>
  `${siteUrl.replace(/\/+$/, "")}${path}`;

/**
 * Scopes an MCP client can be granted, each checked by the tools that need it. The
 * consent page describes every one (`oauth.scopes.*` in packages/i18n).
 */
export const MCP_SCOPES = ["todos:read", "todos:write", "documents:read"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Identity scopes the authorization server also offers (OIDC). */
export const IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/** Which scopes each server's tools use (the rest are for the other server). */
export const MCP_SERVER_SCOPES = {
  [MCP_PATH]: ["todos:read", "todos:write"],
  [AI_MCP_PATH]: ["documents:read"],
} as const satisfies Record<string, readonly McpScope[]>;

/** The access-token claim naming the workspace (organization id) the token acts in. */
export const ORG_CLAIM = "org";

/** Access tokens can't be revoked once issued, so they are short-lived; refresh tokens can. */
export const MCP_ACCESS_TOKEN_SECONDS = 15 * 60;
