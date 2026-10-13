/**
 * An OAuth client's side of the flow against the API under test, as an MCP client does
 * it: registration (native, public, loopback redirect), authorization with PKCE, the
 * consent answer, token requests. Shared by the OAuth and MCP integration tests.
 */
import { createHash, randomBytes } from "node:crypto";
import { AI_MCP_PATH, MCP_PATH, mcpResource, ORG_CLAIM } from "@repo/contracts/mcp";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import pg from "pg";
import { expect } from "vitest";
import { createSession, type Harness, newEmail, newPassword, takeOtp } from "./harness";

export const REDIRECT_URI = "http://127.0.0.1:9/callback";

export function oauthClient(harness: () => Harness) {
  const site = () => process.env.BETTER_AUTH_URL as string;
  const resource = (path: typeof MCP_PATH | typeof AI_MCP_PATH = MCP_PATH) =>
    mcpResource(site(), path);

  async function signedIn() {
    const session = createSession(harness());
    const email = newEmail();
    await session.auth("/sign-up/email", { email, password: newPassword(), name: "Client user" });
    const { otp } = await takeOtp(harness(), email);
    await session.auth("/email-otp/verify-email", { email, otp });
    return { session, email, me: await session.rpc.user.me() };
  }

  /** Registers a client the way a desktop MCP client does: native, public, loopback redirect. */
  async function register(metadata: Record<string, unknown> = {}) {
    const response = await fetch(`${harness().baseUrl}/api/auth/oauth2/register`, {
      method: "POST",
      // Registration is rate-limited per address; each test client comes from its own.
      headers: { "content-type": "application/json", "x-forwarded-for": randomIp() },
      body: JSON.stringify({
        client_name: "Test MCP client",
        application_type: "native",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...metadata,
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function client() {
    const { status, body } = await register();
    expect(status, JSON.stringify(body)).toBe(201);
    return body.client_id as string;
  }

  const randomIp = () =>
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  function pkce() {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  }

  /** Where a better-auth redirect points, whether sent as a 302 or as `{ redirect, url }`. */
  async function redirectOf(response: Response) {
    if (response.status >= 300 && response.status < 400) {
      return new URL(response.headers.get("location") as string, site());
    }
    const body = (await response.json()) as { url?: string };
    expect(body.url, JSON.stringify(body)).toEqual(expect.any(String));
    return new URL(body.url as string, site());
  }

  function cookieHeader(session: Session) {
    return [...session.cookies()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async function authorize(
    session: Session | undefined,
    clientId: string,
    challenge: string,
    params: Record<string, string> = {},
  ) {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "openid offline_access todos:read todos:write",
      state: "state-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: resource(),
      ...params,
    });
    const response = await fetch(`${harness().baseUrl}/api/auth/oauth2/authorize?${query}`, {
      redirect: "manual",
      headers: {
        "x-forwarded-for": session?.ip ?? randomIp(),
        ...(session && { cookie: cookieHeader(session), origin: site() }),
      },
    });
    return redirectOf(response);
  }

  /** Answers the consent page the authorization request was sent to. */
  async function consent(session: Session, consentUrl: URL, accept: boolean) {
    const response = await session.auth<{ url?: string }>("/oauth2/consent", {
      accept,
      oauth_query: consentUrl.search.slice(1),
    });
    expect(response.body.url, JSON.stringify(response.body)).toEqual(expect.any(String));
    return new URL(response.body.url as string);
  }

  /** A token request, from its own address as a separate client machine would be. */
  async function token(form: Record<string, string>) {
    const response = await fetch(`${harness().baseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": randomIp(),
      },
      body: new URLSearchParams(form),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** The whole authorization-code flow for a signed-in user, returning the token response. */
  async function grant(session: Session, clientId: string, params: Record<string, string> = {}) {
    const { verifier, challenge } = pkce();
    const consentUrl = await authorize(session, clientId, challenge, params);
    expect(consentUrl.pathname, consentUrl.toString()).toBe("/oauth/consent");
    const callback = await consent(session, consentUrl, true);
    const code = callback.searchParams.get("code") as string;
    const tokens = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: params.resource ?? resource(),
    });
    expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
    return tokens.body as { access_token: string; refresh_token: string; expires_in: number };
  }

  async function claimsOf(accessToken: string, audience = resource()) {
    const jwks = createRemoteJWKSet(new URL(`${harness().baseUrl}/api/auth/jwks`));
    const { payload } = await jwtVerify(accessToken, jwks, {
      issuer: new URL("/api/auth", site()).toString(),
      audience,
    });
    return payload as JWTPayload & { scope: string; [ORG_CLAIM]: string };
  }

  /** auth.mcp_grant_active as an MCP server calls it (as its own database role). */
  async function grantActive(clientId: string, userId: string, orgId: string) {
    const db = new pg.Client({ connectionString: harness().testDb.urlFor("app_api") });
    await db.connect();
    try {
      const { rows } = await db.query<{ active: boolean }>(
        "SELECT auth.mcp_grant_active($1, $2, $3) AS active",
        [clientId, userId, orgId],
      );
      return rows[0]?.active;
    } finally {
      await db.end();
    }
  }

  return {
    site,
    resource,
    signedIn,
    register,
    client,
    randomIp,
    pkce,
    redirectOf,
    cookieHeader,
    authorize,
    consent,
    token,
    grant,
    claimsOf,
    grantActive,
  };
}

export type Session = ReturnType<typeof createSession>;
