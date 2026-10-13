/**
 * What an API key may do. A procedure that API keys may call names the scope it needs
 * in its contract (`.meta({ apiKeyScope: "todos:read" })`, see ProcedureMeta in
 * ./base.ts); every other procedure is for signed-in people only, so a key can never
 * reach account settings, billing or key management itself. The settings page describes each scope (`workspace.apiKeys.scopes.*`
 * in packages/i18n).
 */
export const API_KEY_SCOPES = [
  "todos:read",
  "todos:write",
  "documents:read",
  "documents:write",
  "audit:read",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** The request header an API key travels in. */
export const API_KEY_HEADER = "x-api-key";
/** Every key starts with this, so leaked keys are easy to recognise and scan for. */
export const API_KEY_PREFIX = "bp_";
