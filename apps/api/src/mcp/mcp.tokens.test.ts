import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createTokenVerifier, KEY_RELOAD_MS } from "./mcp.tokens";

const ISSUER = "https://site.test/api/auth";
const AUDIENCE = "https://site.test/api/mcp";
const ORG = "0199a3c4-0000-7000-8000-00000000000a";
const USER = "0199a3c4-0000-7000-8000-00000000000b";

async function keyPair(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: "EdDSA" } };
}

async function sign(
  key: Awaited<ReturnType<typeof keyPair>>,
  claims: Record<string, unknown> = {},
  options: { issuer?: string; audience?: string; expiresIn?: string } = {},
) {
  return new SignJWT({ org: ORG, azp: "client-1", scope: "todos:read", ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
    .setSubject(USER)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "15m")
    .sign(key.privateKey);
}

function verifierFor(keys: () => JSONWebKeySet, grant = true, now = () => 0) {
  const calls: string[][] = [];
  const verify = createTokenVerifier({
    now,
    keys: async () => keys(),
    issuer: ISSUER,
    audience: AUDIENCE,
    grantActive: async (...args) => {
      calls.push(args);
      return grant;
    },
  });
  return { verify, calls };
}

describe("MCP access tokens", () => {
  it("accept a valid token and name the caller", async () => {
    const key = await keyPair("k1");
    const { verify, calls } = verifierFor(() => ({ keys: [key.jwk] }));
    const result = await verify(await sign(key, { scope: "todos:read todos:write" }));
    expect(result).toMatchObject({
      ok: true,
      caller: { userId: USER, orgId: ORG, clientId: "client-1" },
    });
    expect(result.ok && [...result.caller.scopes]).toEqual(["todos:read", "todos:write"]);
    expect(calls).toEqual([["client-1", USER, ORG]]);
  });

  it.each([
    ["expired", { expiresIn: "-1m" }, "The access token expired"],
    ["from another issuer", { issuer: "https://evil.test" }, "Invalid access token"],
    ["for another resource", { audience: "https://site.test/ai/mcp" }, "Invalid access token"],
  ])("refuse a token %s", async (_case, options, description) => {
    const key = await keyPair("k1");
    const { verify } = verifierFor(() => ({ keys: [key.jwk] }));
    expect(await verify(await sign(key, {}, options))).toEqual({ ok: false, description });
  });

  it("refuse a token signed with a key that isn't ours", async () => {
    const ours = await keyPair("k1");
    const theirs = await keyPair("k1");
    const { verify } = verifierFor(() => ({ keys: [ours.jwk] }));
    expect(await verify(await sign(theirs))).toMatchObject({ ok: false });
  });

  it("refuse a token that names no workspace or client", async () => {
    const key = await keyPair("k1");
    const { verify } = verifierFor(() => ({ keys: [key.jwk] }));
    expect(await verify(await sign(key, { org: undefined }))).toMatchObject({ ok: false });
    expect(await verify(await sign(key, { org: "org-1" }))).toMatchObject({ ok: false });
    expect(await verify(await sign(key, { azp: undefined }))).toMatchObject({ ok: false });
  });

  it("grant no scopes to a token that names none", async () => {
    const key = await keyPair("k1");
    const { verify } = verifierFor(() => ({ keys: [key.jwk] }));
    const result = await verify(await sign(key, { scope: undefined }));
    expect(result.ok && [...result.caller.scopes]).toEqual([]);
  });

  it("refuse a token whose grant no longer stands", async () => {
    const key = await keyPair("k1");
    const { verify } = verifierFor(() => ({ keys: [key.jwk] }), false);
    expect(await verify(await sign(key))).toEqual({
      ok: false,
      description: "The app was disconnected or left the workspace",
    });
  });

  it("reload keys once when a token uses a key signed after a rotation", async () => {
    const first = await keyPair("k1");
    const second = await keyPair("k2");
    let published: JSONWebKeySet = { keys: [first.jwk] };
    let loads = 0;
    let clock = 0;
    const { verify } = verifierFor(
      () => {
        loads++;
        return published;
      },
      true,
      () => clock,
    );
    expect((await verify(await sign(first))).ok).toBe(true);
    published = { keys: [first.jwk, second.jwk] };
    clock = KEY_RELOAD_MS;
    expect((await verify(await sign(second))).ok).toBe(true);
    expect((await verify(await sign(second))).ok).toBe(true);
    expect(loads).toBe(2);
  });

  it("reload at most every half minute, so made-up key ids don't each cost a query", async () => {
    const ours = await keyPair("k1");
    const unknown = await keyPair("made-up");
    let loads = 0;
    let clock = 0;
    const { verify } = verifierFor(
      () => {
        loads++;
        return { keys: [ours.jwk] };
      },
      true,
      () => clock,
    );
    expect((await verify(await sign(ours))).ok).toBe(true);
    for (let i = 0; i < 20; i++) {
      expect((await verify(await sign(unknown))).ok).toBe(false);
    }
    expect(loads).toBe(1);
    clock = KEY_RELOAD_MS;
    await verify(await sign(unknown));
    expect(loads).toBe(2);
  });
});
