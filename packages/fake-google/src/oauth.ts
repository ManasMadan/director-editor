/**
 * Google sign-in (OAuth 2.0 with OpenID Connect), as better-auth's Google provider uses
 * it: the authorization endpoint (`/o/oauth2/v2/auth`, accounts.google.com's), which
 * consents at once for the account `login_hint` names and redirects back with a code;
 * the token endpoint (`/token`, oauth2.googleapis.com's), which trades a code or a
 * refresh token for tokens and an RS256 ID token; and the keys that sign them
 * (`/oauth2/v3/certs`, www.googleapis.com's). Like Google with `include_granted_scopes`,
 * a new consent adds its scopes to the ones the account already granted the client.
 *
 * better-auth calls Google's real hosts; a test sends those requests here (apps/api's
 * Google sign-in test rewrites their origin to this server's).
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";

/** What a member granted a client: an access token carries one. */
export interface Grant {
  email: string;
  clientId: string;
  scopes: string[];
}

export interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: object;
}

const ISSUER = "https://accounts.google.com";
const TOKEN_LIFETIME_S = 3599;
/** Whose consent a request gets when it names no account. */
const DEFAULT_EMAIL = "member@example.com";

const opaque = () => randomBytes(24).toString("base64url");
const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Google's signing key: ID tokens signed with it, and its public half to check them. */
function createSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = opaque();
  return {
    idToken({ email, clientId }: Grant) {
      const now = Math.floor(Date.now() / 1000);
      const head = base64url({ alg: "RS256", kid: keyId, typ: "JWT" });
      const claims = base64url({
        iss: ISSUER,
        aud: clientId,
        azp: clientId,
        sub: createHash("sha256").update(email).digest("hex").slice(0, 21),
        email,
        email_verified: true,
        name: email.split("@")[0],
        iat: now,
        exp: now + TOKEN_LIFETIME_S,
      });
      const signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(privateKey);
      return `${head}.${claims}.${signature.toString("base64url")}`;
    },
    certs(): Answer {
      const jwk = publicKey.export({ format: "jwk" });
      return { status: 200, body: { keys: [{ ...jwk, kid: keyId, alg: "RS256", use: "sig" }] } };
    },
  };
}

export function createOAuth() {
  const signer = createSigner();
  const codes = new Map<string, Grant>();
  const accessTokens = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  // What each account granted each client so far, by `${email} ${clientId}`.
  const granted = new Map<string, string[]>();

  const issue = (grant: Grant, { refresh }: { refresh: boolean }) => {
    const accessToken = opaque();
    accessTokens.set(accessToken, grant);
    const tokens = {
      access_token: accessToken,
      expires_in: TOKEN_LIFETIME_S,
      scope: grant.scopes.join(" "),
      token_type: "Bearer",
    };
    if (!refresh) {
      return tokens;
    }
    const refreshToken = opaque();
    refreshTokens.set(refreshToken, grant);
    return { ...tokens, refresh_token: refreshToken, id_token: signer.idToken(grant) };
  };
  const redeem = (grant: Grant | undefined, refresh: boolean): Answer =>
    grant
      ? { status: 200, body: issue(grant, { refresh }) }
      : { status: 400, body: { error: "invalid_grant" } };

  return {
    authorize(query: URLSearchParams): Answer {
      const redirect = query.get("redirect_uri");
      const clientId = query.get("client_id");
      if (!redirect || !clientId || query.get("response_type") !== "code") {
        return { status: 400, body: { error: "invalid_request" } };
      }
      const email = query.get("login_hint") || DEFAULT_EMAIL;
      const account = `${email} ${clientId}`;
      const requested = (query.get("scope") ?? "").split(" ").filter(Boolean);
      const scopes = [...new Set([...(granted.get(account) ?? []), ...requested])];
      granted.set(account, scopes);
      const code = opaque();
      codes.set(code, { email, clientId, scopes });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", query.get("state") ?? "");
      return { status: 302, headers: { location: back.toString() } };
    },

    token(form: URLSearchParams): Answer {
      const kind = form.get("grant_type");
      if (kind === "authorization_code") {
        const code = form.get("code") ?? "";
        const grant = codes.get(code);
        codes.delete(code);
        return redeem(grant, true);
      }
      if (kind === "refresh_token") {
        return redeem(refreshTokens.get(form.get("refresh_token") ?? ""), false);
      }
      return { status: 400, body: { error: "unsupported_grant_type" } };
    },

    certs: signer.certs,

    /** The grant behind an `Authorization: Bearer` header, if it's a live access token. */
    grantOf(authorization: string | undefined): Grant | undefined {
      const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
      return token ? accessTokens.get(token) : undefined;
    },
  };
}

export type OAuth = ReturnType<typeof createOAuth>;
