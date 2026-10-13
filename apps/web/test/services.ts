/**
 * Where the browser tests' services are, shared by vitest.config.ts (the proxy), the
 * global setup (which starts them) and the commands (which reach them from Node).
 * Values that must agree across those modules live in process.env, set once.
 */
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";

/** A port nothing listens on right now. */
function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(),
      );
    });
  });
}

for (const name of ["API_FULL", "API_BARE", "SITE_FULL", "SITE_BARE"]) {
  process.env[`WEB_TESTS_${name}_PORT`] ??= String(await freePort());
}
// Browser push needs a real P-256 public key for PushManager.subscribe.
// (The uncompressed point is the last 65 bytes of the SPKI encoding.)
process.env.WEB_TESTS_VAPID_PUBLIC_KEY ??= generateKeyPairSync("ec", { namedCurve: "P-256" })
  .publicKey.export({ type: "spki", format: "der" })
  .subarray(-65)
  .toString("base64url");

const at = (host: string, port: string | undefined) => ({
  port: Number(port),
  url: `http://${host}:${port}`,
});

/** The API with every optional feature on, and the one with them off (captcha on). */
export const API = {
  full: at("127.0.0.1", process.env.WEB_TESTS_API_FULL_PORT),
  bare: at("127.0.0.1", process.env.WEB_TESTS_API_BARE_PORT),
};

/**
 * Where each browser project serves its test pages: the site's origin as each API knows
 * it (WEB_URL), so cookies, CORS, WebAuthn and emailed links all work as on the real site.
 */
export const SITE = {
  full: at("localhost", process.env.WEB_TESTS_SITE_FULL_PORT),
  bare: at("localhost", process.env.WEB_TESTS_SITE_BARE_PORT),
};

/**
 * The Valkey database both APIs use, the web's own (docs/testing.md lists who has which).
 * Nothing here consumes the queues the APIs fill, so OTPs are read from them.
 */
export const REDIS_URL = (() => {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:56379");
  url.pathname = "/18";
  return url.toString();
})();

export const VAPID_PUBLIC_KEY = process.env.WEB_TESTS_VAPID_PUBLIC_KEY;

/** Cloudflare's published always-pass Turnstile test keys. */
export const CAPTCHA = {
  siteKey: "1x00000000000000000000AA",
  secretKey: "1x0000000000000000000000000000000AA",
};

export const STRIPE = {
  secretKey: "sk_test_webtests",
  webhookSecret: "whsec_webtests",
  monthly: "price_pro_monthly_web",
  yearly: "price_pro_yearly_web",
};

export interface Services {
  databaseUrl: string;
  stripeUrl: string;
  close(): Promise<void>;
}

/**
 * The running services, for the commands (they run in the same process as the global
 * setup, which starts them, but load as a separate module).
 */
export async function services(): Promise<Services> {
  const started = (globalThis as { webTestServices?: Promise<Services> }).webTestServices;
  if (!started) {
    throw new Error("the browser tests' services aren't running");
  }
  return started;
}
