/**
 * The OAuth 2.1 authorization server MCP clients use, over plain HTTP the way a client
 * drives it: discovery, registration, authorization with PKCE, the consent step (where
 * the user picks the workspace), tokens, refresh and revocation, and the refusals.
 * The consent page itself is covered end to end in apps/web/e2e/oauth.spec.ts.
 */
import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { AI_MCP_PATH, MCP_ACCESS_TOKEN_SECONDS, MCP_PATH, ORG_CLAIM } from "@repo/contracts/mcp";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  type Harness,
  newEmail,
  newPassword,
  startApi,
  takeNotification,
  takeOtp,
} from "./harness";
import { oauthClient, REDIRECT_URI } from "./oauth-client";

let harness: Harness;

beforeAll(async () => {
  // Versioned secrets (a rotated BETTER_AUTH_SECRET): the signing keys behind every
  // token below are encrypted with them.
  harness = await startApi(4, { BETTER_AUTH_SECRETS: `1:${"r".repeat(40)}` });
});
afterAll(() => harness?.close());

const {
  site: siteUrl,
  resource,
  signedIn,
  register,
  client,
  pkce,
  redirectOf,
  cookieHeader,
  authorize,
  consent,
  token,
  grant,
  claimsOf,
  grantActive,
} = oauthClient(() => harness);

describe("discovery", () => {
  it("publishes authorization server metadata under the issuer's path", async () => {
    const response = await fetch(
      `${harness.baseUrl}/.well-known/oauth-authorization-server/api/auth`,
    );
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: new URL("/api/auth", siteUrl()).toString(),
      authorization_endpoint: expect.stringContaining("/api/auth/oauth2/authorize"),
      token_endpoint: expect.stringContaining("/api/auth/oauth2/token"),
      registration_endpoint: expect.stringContaining("/api/auth/oauth2/register"),
      code_challenge_methods_supported: ["S256"],
    });
    expect(metadata.scopes_supported).toEqual(
      expect.arrayContaining(["todos:read", "todos:write", "documents:read"]),
    );
  });

  it("publishes the MCP server's protected resource metadata", async () => {
    const response = await fetch(`${harness.baseUrl}/.well-known/oauth-protected-resource/api/mcp`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: resource(),
      authorization_servers: [new URL("/api/auth", siteUrl()).toString()],
    });
  });
});

describe("authorization", () => {
  it("issues a short-lived token for the workspace the user approved", async () => {
    const { session, me } = await signedIn();
    const tokens = await grant(session, await client());
    expect(tokens.expires_in).toBe(MCP_ACCESS_TOKEN_SECONDS);
    const claims = await claimsOf(tokens.access_token);
    expect(claims.sub).toBe(me.id);
    expect(claims[ORG_CLAIM]).toBe(me.activeOrganizationId);
    expect(claims.scope.split(" ")).toEqual(expect.arrayContaining(["todos:read", "todos:write"]));
  });

  it("sends a signed-out user to sign in first, keeping the signed request", async () => {
    const { challenge } = pkce();
    const clientId = await client();
    const login = await authorize(undefined, clientId, challenge);
    expect(login.pathname).toBe("/sign-in");
    expect(login.searchParams.get("client_id")).toBe(clientId);
    expect(login.searchParams.get("code_challenge")).toBe(challenge);
    // An HMAC-SHA-256 of the request, in base64.
    expect(login.searchParams.get("sig")).toMatch(/^[\w+/]{43}=$/);
  });

  it("resumes the authorization when the user signs in from that page", async () => {
    const clientId = await client();
    const { challenge } = pkce();
    const login = await authorize(undefined, clientId, challenge);
    const session = createSession(harness);
    const email = newEmail();
    const password = newPassword();
    await session.auth("/sign-up/email", { email, password, name: "Later" });
    const { otp } = await takeOtp(harness, email);
    // Verifying the email signs the user in; with the signed request attached, the
    // answer is the next step of the authorization instead of the app.
    const verified = await session.auth<{ url?: string }>("/email-otp/verify-email", {
      email,
      otp,
      oauth_query: login.search.slice(1),
    });
    expect(new URL(verified.body.url as string, siteUrl()).pathname).toBe("/oauth/consent");
  });

  it("asks again for each workspace, and binds the token to the one chosen", async () => {
    const { session, me } = await signedIn();
    const clientId = await client();
    await grant(session, clientId);
    const team = await session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    await session.auth("/organization/set-active", { organizationId: team.body.id });
    // A consent for the personal workspace doesn't cover the team one.
    const tokens = await grant(session, clientId);
    expect((await claimsOf(tokens.access_token))[ORG_CLAIM]).toBe(team.body.id);
    expect(team.body.id).not.toBe(me.activeOrganizationId);
  });

  it("switching workspace on the consent page re-runs the request for that workspace", async () => {
    const { session } = await signedIn();
    const team = await session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    const clientId = await client();
    const { verifier, challenge } = pkce();
    const consentUrl = await authorize(session, clientId, challenge);
    // The consent page switches workspace with its signed request attached (the auth
    // client adds it to every request from that page).
    const switched = await session.auth<{ redirect: boolean; url: string }>(
      "/organization/set-active",
      { organizationId: team.body.id, oauth_query: consentUrl.search.slice(1) },
    );
    const again = new URL(switched.body.url, siteUrl());
    expect(again.pathname).toBe("/oauth/consent");
    const callback = await consent(session, again, true);
    const tokens = await token({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") as string,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: resource(),
    });
    expect((await claimsOf(tokens.body.access_token as string))[ORG_CLAIM]).toBe(team.body.id);
  });

  it("skips the consent page once a workspace is approved for the same scopes", async () => {
    const { session } = await signedIn();
    const clientId = await client();
    await grant(session, clientId);
    const { verifier, challenge } = pkce();
    const callback = await authorize(session, clientId, challenge);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    const tokens = await token({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") as string,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: resource(),
    });
    expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
  });

  it("returns access_denied to the client when the user declines", async () => {
    const { session } = await signedIn();
    const { challenge } = pkce();
    const consentUrl = await authorize(session, await client(), challenge);
    const callback = await consent(session, consentUrl, false);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("state-1");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  it("refuses an approval without a workspace to approve it for", async () => {
    const { session } = await signedIn();
    const { challenge } = pkce();
    const consentUrl = await authorize(session, await client(), challenge);
    await session.auth("/organization/set-active", { organizationId: null });
    const response = await session.auth<{ url?: string; error?: string }>("/oauth2/consent", {
      accept: true,
      oauth_query: consentUrl.search.slice(1),
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "invalid_request" });
    expect(response.body.url).toBeUndefined();
  });

  it("refuses a tampered consent request", async () => {
    const { session } = await signedIn();
    const { challenge } = pkce();
    const consentUrl = await authorize(session, await client(), challenge);
    consentUrl.searchParams.set("scope", "openid todos:read todos:write documents:read");
    const response = await session.auth<{ url?: string }>("/oauth2/consent", {
      accept: true,
      oauth_query: consentUrl.search.slice(1),
    });
    expect(response.status).toBe(400);
    expect(response.body.url).toBeUndefined();
  });

  it("issues tokens for the Python MCP server with only its own scope", async () => {
    const { session } = await signedIn();
    const tokens = await grant(session, await client(), {
      scope: "openid documents:read",
      resource: resource(AI_MCP_PATH),
    });
    const claims = await claimsOf(tokens.access_token, resource(AI_MCP_PATH));
    expect(claims.scope.split(" ")).toContain("documents:read");
    await expect(claimsOf(tokens.access_token, resource(MCP_PATH))).rejects.toThrow();
  });

  it("refuses a request whose scopes the MCP server doesn't serve", async () => {
    const { session } = await signedIn();
    const { challenge } = pkce();
    const answer = await authorize(session, await client(), challenge, {
      scope: "openid documents:read",
      resource: resource(MCP_PATH),
    });
    expect(answer.searchParams.get("error"), answer.toString()).toBe("invalid_scope");
  });

  it("leaves another server's scope out of a token", async () => {
    const { session } = await signedIn();
    const tokens = await grant(session, await client(), {
      scope: "openid todos:read documents:read",
      resource: resource(MCP_PATH),
    });
    // The token is narrowed to what this server serves.
    expect((await claimsOf(tokens.access_token)).scope).toBe("todos:read");
  });

  it("refuses an unknown resource", async () => {
    const { session } = await signedIn();
    const { challenge } = pkce();
    const answer = await authorize(session, await client(), challenge, {
      resource: "https://elsewhere.example/mcp",
    });
    expect(answer.searchParams.get("error")).toBe("invalid_target");
  });

  it("requires PKCE", async () => {
    const { session } = await signedIn();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: await client(),
      redirect_uri: REDIRECT_URI,
      scope: "openid todos:read",
      state: "s",
      resource: resource(),
    });
    const response = await fetch(`${harness.baseUrl}/api/auth/oauth2/authorize?${query}`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(session) },
    });
    const answer = await redirectOf(response);
    expect(answer.searchParams.get("error")).toBe("invalid_request");
  });

  it("refuses a code without the matching verifier, and a code used twice", async () => {
    const { session } = await signedIn();
    const clientId = await client();
    const { verifier, challenge } = pkce();
    const consentUrl = await authorize(session, clientId, challenge);
    const callback = await consent(session, consentUrl, true);
    const code = callback.searchParams.get("code") as string;
    const exchange = (codeVerifier: string) =>
      token({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: codeVerifier,
        resource: resource(),
      });
    const wrong = await exchange(pkce().verifier);
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.body.access_token).toBeUndefined();
    // Consent is on record now, so authorizing again answers with a fresh code directly.
    const second = await authorize(session, clientId, challenge);
    const code2 = second.searchParams.get("code") as string;
    const ok = await token({
      grant_type: "authorization_code",
      code: code2,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: resource(),
    });
    expect(ok.status).toBe(200);
    const again = await token({
      grant_type: "authorization_code",
      code: code2,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: resource(),
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.body.access_token).toBeUndefined();
  });
});

describe("refresh and revocation", () => {
  it("rotates refresh tokens", async () => {
    const { session, me } = await signedIn();
    const clientId = await client();
    const tokens = await grant(session, clientId);
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: resource(),
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(tokens.refresh_token);
    expect((await claimsOf(refreshed.body.access_token as string))[ORG_CLAIM]).toBe(
      me.activeOrganizationId,
    );
  });

  it("a revoked refresh token gets nothing more", async () => {
    const { session } = await signedIn();
    const clientId = await client();
    const tokens = await grant(session, clientId);
    const revoke = await fetch(`${harness.baseUrl}/api/auth/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tokens.refresh_token,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }),
    });
    expect(revoke.status).toBe(200);
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: resource(),
    });
    expect(refreshed.status).toBe(400);
  });

  it("stops refreshing once the user leaves the workspace", async () => {
    const owner = await signedIn();
    const org = await owner.session.auth<{ id: string }>("/organization/create", {
      name: "Shared",
      slug: `shared-${randomUUID().slice(0, 8)}`,
    });
    const member = await signedIn();
    await owner.session.auth("/organization/invite-member", {
      email: member.email,
      role: "member",
      organizationId: org.body.id,
    });
    const invitation = await takeNotification(harness, "org.invitation", member.email);
    await member.session.auth("/organization/accept-invitation", {
      invitationId: new URL(invitation.data.acceptUrl).pathname.split("/").at(-1),
    });
    await member.session.auth("/organization/set-active", { organizationId: org.body.id });
    const clientId = await client();
    const tokens = await grant(member.session, clientId);
    expect((await claimsOf(tokens.access_token))[ORG_CLAIM]).toBe(org.body.id);

    await owner.session.auth("/organization/remove-member", {
      memberIdOrEmail: member.email,
      organizationId: org.body.id,
    });
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: resource(),
    });
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
    expect(refreshed.body.access_token).toBeUndefined();
  });

  it("deleting a workspace deletes the grants approved for it", async () => {
    const { session } = await signedIn();
    const org = await session.auth<{ id: string }>("/organization/create", {
      name: "Temporary",
      slug: `temp-${randomUUID().slice(0, 8)}`,
    });
    await session.auth("/organization/set-active", { organizationId: org.body.id });
    await grant(session, await client());
    const db = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await db.connect();
    const grants = async () =>
      Number(
        (
          await db.query<{ count: string }>(
            "SELECT count(*) FROM auth.oauth_consent WHERE reference_id = $1",
            [org.body.id],
          )
        ).rows[0]?.count,
      );
    try {
      expect(await grants()).toBe(1);
      await session.auth("/organization/delete", { organizationId: org.body.id });
      expect(await grants()).toBe(0);
    } finally {
      await db.end();
    }
  });
});

describe("registration", () => {
  it("registers public clients and rejects unsafe redirect URIs", async () => {
    expect((await register()).status).toBe(201);
    const insecure = await register({
      application_type: "web",
      redirect_uris: ["http://attacker.example/callback"],
    });
    expect(insecure.status).toBe(400);
  });

  it("limits registrations per address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const response = await fetch(`${harness.baseUrl}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.200.0.1" },
        body: JSON.stringify({
          client_name: "Spam",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
        }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });
});

describe("connected apps", () => {
  it("emails a security alert when an app is connected", async () => {
    const { session, email } = await signedIn();
    await grant(session, await client());
    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert.data.event).toBe("app-connected");
  });

  it("lists each app with the workspace it may use and when it last did", async () => {
    const { session, me } = await signedIn();
    const clientId = await client();
    await grant(session, clientId);
    const [app, ...rest] = await session.rpc.apps.list();
    expect(rest).toEqual([]);
    expect(app).toMatchObject({
      clientId,
      name: "Test MCP client",
      workspace: { id: me.activeOrganizationId },
      scopes: expect.arrayContaining(["todos:read", "todos:write"]),
      connectedAt: expect.any(Date),
      lastUsedAt: expect.any(Date),
    });
  });

  it("shows no last use for an app that has never renewed its access", async () => {
    const { session } = await signedIn();
    await grant(session, await client(), { scope: "openid todos:read" });
    const [app] = await session.rpc.apps.list();
    expect(app?.lastUsedAt).toBeNull();
  });

  it("disconnecting revokes the approval and every token issued under it", async () => {
    const { session, me } = await signedIn();
    const clientId = await client();
    const tokens = await grant(session, clientId);
    const orgId = me.activeOrganizationId as string;
    expect(await grantActive(clientId, me.id, orgId)).toBe(true);

    const [app] = await session.rpc.apps.list();
    await session.rpc.apps.disconnect({ id: app?.id as string });
    expect(await session.rpc.apps.list()).toEqual([]);
    // Access tokens still verify by signature until they expire; the grant check is what
    // makes MCP servers refuse them at once.
    expect(await grantActive(clientId, me.id, orgId)).toBe(false);
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: resource(),
    });
    expect(refreshed.body.access_token).toBeUndefined();
    // Connecting again asks for consent again.
    const { challenge } = pkce();
    expect((await authorize(session, clientId, challenge)).pathname).toBe("/oauth/consent");
  });

  it("can't disconnect another user's app", async () => {
    const owner = await signedIn();
    await grant(owner.session, await client());
    const [app] = await owner.session.rpc.apps.list();
    const other = await signedIn();
    const error = await other.session.rpc.apps
      .disconnect({ id: app?.id as string })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe("APP_NOT_FOUND");
    expect(await owner.session.rpc.apps.list()).toHaveLength(1);
  });

  it("the grant stops holding once the user leaves the workspace", async () => {
    const { session, me } = await signedIn();
    const owner = await signedIn();
    const org = await owner.session.auth<{ id: string }>("/organization/create", {
      name: "Theirs",
      slug: `theirs-${randomUUID().slice(0, 8)}`,
    });
    await owner.session.auth("/organization/invite-member", {
      email: (await session.rpc.user.me()).email,
      role: "member",
      organizationId: org.body.id,
    });
    const invitation = await takeNotification(
      harness,
      "org.invitation",
      (await session.rpc.user.me()).email,
    );
    await session.auth("/organization/accept-invitation", {
      invitationId: new URL(invitation.data.acceptUrl).pathname.split("/").at(-1),
    });
    await session.auth("/organization/set-active", { organizationId: org.body.id });
    const clientId = await client();
    await grant(session, clientId);
    expect(await grantActive(clientId, me.id, org.body.id)).toBe(true);
    await session.auth("/organization/leave", { organizationId: org.body.id });
    expect(await grantActive(clientId, me.id, org.body.id)).toBe(false);
  });

  it("needs a session", async () => {
    const error = await createSession(harness)
      .rpc.apps.list()
      .catch((e: unknown) => e);
    expect((error as ORPCError<string, unknown>).code).toBe("UNAUTHENTICATED");
  });
});

describe("client ID metadata documents", () => {
  async function authorizeAs(clientId: string) {
    const { session } = await signedIn();
    const { challenge } = pkce();
    return fetch(
      `${harness.baseUrl}/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "openid todos:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: resource(),
      })}`,
      { redirect: "manual", headers: { cookie: cookieHeader(session) } },
    );
  }

  it.each([
    "https://127.0.0.1/client.json",
    "https://localhost/client.json",
    "https://10.0.0.5/client.json",
  ])("never fetches a metadata document from a private address: %s", async (clientId) => {
    const response = await authorizeAs(clientId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_client",
      error_description: "client_id URL must not target a private or reserved address",
    });
  });

  it("treats a non-HTTPS client id as an unknown client", async () => {
    const answer = await redirectOf(await authorizeAs("http://client.example/client.json"));
    expect(answer.pathname).toBe("/api/auth/error");
    expect(answer.searchParams.get("error")).toBe("invalid_client");
  });

  // Needs a client whose metadata document is on a public HTTPS URL (the transport
  // refuses loopback and private addresses by design). Set E2E_CIMD_CLIENT_ID to one.
  it.skipIf(!process.env.E2E_CIMD_CLIENT_ID)(
    "discovers a client from its public metadata document",
    async () => {
      const { session } = await signedIn();
      const { challenge } = pkce();
      const consentUrl = await authorize(
        session,
        process.env.E2E_CIMD_CLIENT_ID as string,
        challenge,
        { redirect_uri: process.env.E2E_CIMD_REDIRECT_URI as string },
      );
      expect(consentUrl.pathname).toBe("/oauth/consent");
    },
  );
});
