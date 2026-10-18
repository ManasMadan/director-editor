/**
 * The mock Google sign-in (OAuth 2.0 with OpenID Connect) and YouTube's resumable upload,
 * driven the way better-auth and apps/api's publisher drive the real ones.
 */
import { createPublicKey, createVerify } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { startFakeGoogle } from "./index";

const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const CLIENT = "client.apps.googleusercontent.com";
const CALLBACK = "http://localhost:3001/api/auth/callback/google";

let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
let audited: Awaited<ReturnType<typeof startFakeGoogle>>;
beforeAll(async () => {
  fake = await startFakeGoogle({ apiKey: "k" });
  audited = await startFakeGoogle({ apiKey: "k", youtubeAudited: true });
});
afterAll(async () => {
  await fake.close();
  await audited.close();
});

const tokens = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  scope: z.string(),
  token_type: z.literal("Bearer"),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
});

/** Consent as the browser gives it: the authorization endpoint's redirect back. */
async function consent(server = fake, query: Record<string, string> = {}) {
  const url = new URL(`${server.url}/o/oauth2/v2/auth`);
  const params = {
    client_id: CLIENT,
    redirect_uri: CALLBACK,
    response_type: "code",
    state: "state-1",
    scope: "openid email profile",
    ...query,
  };
  // An empty value leaves the parameter out.
  for (const [name, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(name, value);
    }
  }
  const response = await fetch(url, { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") };
}

async function exchange(form: Record<string, string>, server = fake) {
  const response = await fetch(`${server.url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  return { status: response.status, json: await response.json() };
}

/** Signs a member in with `scope` and returns their tokens. */
async function signIn(email: string, scope: string, server = fake) {
  const { location } = await consent(server, { login_hint: email, scope });
  const code = new URL(location ?? "").searchParams.get("code") ?? "";
  const { json } = await exchange(
    { grant_type: "authorization_code", code, client_id: CLIENT, redirect_uri: CALLBACK },
    server,
  );
  return tokens.parse(json);
}

const decoded = (part: string | undefined) =>
  z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(Buffer.from(part ?? "", "base64url").toString()));

function claimsOf(idToken: string) {
  const [header, payload, signature] = idToken.split(".");
  return {
    header: z.object({ kid: z.string() }).parse(decoded(header)),
    claims: decoded(payload),
    signed: `${header}.${payload}`,
    signature: Buffer.from(signature ?? "", "base64url"),
  };
}

describe("the mock Google sign-in", () => {
  it("sends the browser back with a code and the state", async () => {
    const { status, location } = await consent();
    expect(status).toBe(302);
    const back = new URL(location ?? "");
    expect(back.origin + back.pathname).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("state-1");
    expect(back.searchParams.get("code")).toMatch(/.+/);
  });

  it("trades the code once for tokens and an ID token signed with its published key", async () => {
    const { location } = await consent(fake, { login_hint: "maya@example.com" });
    const code = new URL(location ?? "").searchParams.get("code") ?? "";
    const form = { grant_type: "authorization_code", code, client_id: CLIENT };
    const first = await exchange(form);
    expect(first.status).toBe(200);
    const granted = tokens.parse(first.json);
    expect(granted.scope.split(" ")).toEqual(["openid", "email", "profile"]);
    const { header, claims, signed, signature } = claimsOf(granted.id_token ?? "");
    expect(claims).toMatchObject({
      iss: "https://accounts.google.com",
      aud: CLIENT,
      email: "maya@example.com",
      email_verified: true,
      name: "maya",
    });
    const certs = z
      .object({
        keys: z.array(z.object({ kid: z.string(), kty: z.string(), n: z.string(), e: z.string() })),
      })
      .parse(await (await fetch(`${fake.url}/oauth2/v3/certs`)).json());
    const jwk = certs.keys.find((key) => key.kid === header.kid);
    const key = createPublicKey({ key: { ...jwk }, format: "jwk" });
    expect(createVerify("RSA-SHA256").update(signed).verify(key, signature)).toBe(true);
    // A code is good once.
    expect((await exchange(form)).json).toEqual({ error: "invalid_grant" });
  });

  it("adds a scope to the ones granted before, and refreshes the access token", async () => {
    const email = "incremental@example.com";
    await signIn(email, "openid email profile");
    const more = await signIn(email, UPLOAD_SCOPE);
    expect(more.scope.split(" ")).toEqual(["openid", "email", "profile", UPLOAD_SCOPE]);
    const refreshed = await exchange({
      grant_type: "refresh_token",
      refresh_token: more.refresh_token ?? "",
      client_id: CLIENT,
    });
    const fresh = tokens.parse(refreshed.json);
    expect(fresh.access_token).not.toBe(more.access_token);
    expect(fresh.refresh_token).toBeUndefined();
    expect(fresh.scope).toBe(more.scope);
  });

  it("sends back an empty state and asks for no scope when the request names none", async () => {
    // Another client, which the default account hasn't granted anything yet.
    const { location } = await consent(fake, { state: "", scope: "", client_id: "other" });
    const code = new URL(location ?? "").searchParams.get("code") ?? "";
    expect(new URL(location ?? "").searchParams.get("state")).toBe("");
    const { json } = await exchange({ grant_type: "authorization_code", code });
    expect(tokens.parse(json).scope).toBe("");
  });

  it("refuses what isn't an OAuth request", async () => {
    expect((await consent(fake, { redirect_uri: "" })).status).toBe(400);
    expect((await exchange({ grant_type: "authorization_code" })).status).toBe(400);
    expect((await exchange({ grant_type: "refresh_token" })).status).toBe(400);
    expect((await exchange({ grant_type: "refresh_token", refresh_token: "nope" })).status).toBe(
      400,
    );
    expect((await exchange({ grant_type: "password" })).json).toEqual({
      error: "unsupported_grant_type",
    });
  });
});

const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const metadata = (privacyStatus = "unlisted", title = "My look #Shorts") => ({
  snippet: { title, description: "Three outfits.", categoryId: "22" },
  status: { privacyStatus, selfDeclaredMadeForKids: false },
});

/** Starts a resumable upload, as apps/api's publisher does. */
function start(token: string | null, body: object, server = fake, length = VIDEO.length) {
  return fetch(`${server.url}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(length),
      "x-upload-content-type": "video/mp4",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

const videoResource = z.object({
  id: z.string().regex(/^[\w-]{11}$/),
  snippet: z.object({ title: z.string() }),
  status: z.object({ privacyStatus: z.string(), uploadStatus: z.literal("uploaded") }),
});

describe("the mock YouTube upload", () => {
  it("takes a video in a resumable upload, kept private while the app isn't audited", async () => {
    const { access_token } = await signIn("creator@example.com", UPLOAD_SCOPE);
    const started = await start(access_token, metadata("public"));
    expect(started.status).toBe(200);
    const session = started.headers.get("location") ?? "";
    expect(session).toContain(`${fake.url}/upload/youtube/v3/videos?`);
    const put = await fetch(session, {
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      body: VIDEO,
    });
    expect(put.status).toBe(200);
    const video = videoResource.parse(await put.json());
    expect(video.status.privacyStatus).toBe("private");
    expect(fake.uploads.at(-1)).toMatchObject({
      id: video.id,
      email: "creator@example.com",
      bytes: VIDEO.length,
      contentType: "video/mp4",
      snippet: { title: "My look #Shorts" },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    });
  });

  it("keeps the asked-for privacy once the app is audited", async () => {
    const { access_token } = await signIn("audited@example.com", UPLOAD_SCOPE, audited);
    const session = (await start(access_token, metadata("public"), audited)).headers.get(
      "location",
    );
    const put = await fetch(session ?? "", { method: "PUT", body: VIDEO });
    expect(videoResource.parse(await put.json()).status.privacyStatus).toBe("public");
  });

  it("refuses a caller without a token, without the upload scope, or without a channel", async () => {
    const reason = async (response: Response) =>
      z
        .object({ error: z.object({ errors: z.array(z.object({ reason: z.string() })) }) })
        .parse(await response.json()).error.errors[0]?.reason;
    const unauthenticated = await start(null, metadata());
    expect([unauthenticated.status, await reason(unauthenticated)]).toEqual([401, "authError"]);
    const signInOnly = await signIn("viewer@example.com", "openid email");
    const scopeless = await start(signInOnly.access_token, metadata());
    expect([scopeless.status, await reason(scopeless)]).toEqual([403, "insufficientPermissions"]);
    const noChannel = await signIn("no-channel@example.com", UPLOAD_SCOPE);
    const signup = await start(noChannel.access_token, metadata());
    expect([signup.status, await reason(signup)]).toEqual([401, "youtubeSignupRequired"]);
  });

  it("refuses metadata YouTube would, and a video that isn't the declared size", async () => {
    const { access_token } = await signIn("strict@example.com", UPLOAD_SCOPE);
    for (const body of [metadata("unlisted", "a <b>"), metadata("everyone"), {}]) {
      expect((await start(access_token, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await start(access_token, metadata(), fake, 0)).status).toBe(400);
    const raw = (body: string) =>
      fetch(`${fake.url}/upload/youtube/v3/videos?uploadType=resumable`, {
        method: "POST",
        headers: { authorization: `Bearer ${access_token}`, "x-upload-content-length": "8" },
        body,
      });
    expect((await raw("")).status).toBe(400);
    expect((await raw("not json")).status).toBe(400);
    // No declared type: YouTube takes it as some video.
    const untyped = await raw(JSON.stringify(metadata()));
    const put = await fetch(untyped.headers.get("location") ?? "", { method: "PUT", body: VIDEO });
    expect(put.status).toBe(200);
    expect(fake.uploads.at(-1)?.contentType).toBe("video/*");
    expect(
      (await fetch(`${fake.url}/upload/youtube/v3/videos?uploadType=resumable`, { method: "PUT" }))
        .status,
    ).toBe(404);
    const session = (await start(access_token, metadata())).headers.get("location") ?? "";
    expect((await fetch(session, { method: "PUT", body: new Uint8Array(3) })).status).toBe(400);
    expect(
      (await fetch(`${fake.url}/upload/youtube/v3/videos?upload_id=gone`, { method: "PUT" }))
        .status,
    ).toBe(404);
    const notResumable = await fetch(`${fake.url}/upload/youtube/v3/videos?part=snippet`, {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}` },
      body: "{}",
    });
    expect(notResumable.status).toBe(400);
  });
});
