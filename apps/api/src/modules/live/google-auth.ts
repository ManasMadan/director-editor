/**
 * Where the live call's Google access token comes from. In production the API runs on a
 * GCE machine whose service account may call Vertex AI, so the token is the metadata
 * server's, cached until a minute before it expires. Locally there is no metadata server:
 * GOOGLE_ACCESS_TOKEN (`gcloud auth print-access-token`, an hour's worth) stands in, and
 * production refuses it at boot (src/env.ts).
 *
 * Swapping it (Workload Identity, a key file, another cloud's federation): write another
 * GoogleAuth and pick it in `createGoogleAuth`; the relay only calls `accessToken()`.
 */
import { MINUTE_MS, PROVIDER_TIMEOUT_MS, SECOND_MS } from "@repo/contracts/time";
import * as z from "zod";

export interface GoogleAuth {
  /** A bearer token for Google Cloud APIs; throws when none can be had. */
  accessToken(): Promise<string>;
}

const METADATA_TOKEN_URL =
  "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";

// A token is refreshed this long before Google says it expires, so a call that starts
// with it never opens the upstream on a token that dies during the handshake.
const EXPIRY_MARGIN_MS = MINUTE_MS;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

/** The GCE metadata server's token for the machine's service account, cached. */
export function metadataServerAuth(url = METADATA_TOKEN_URL, now = Date.now): GoogleAuth {
  let cached: { token: string; refreshAt: number } | null = null;
  return {
    async accessToken() {
      if (cached && now() < cached.refreshAt) {
        return cached.token;
      }
      const response = await fetch(url, {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`the metadata server answered ${response.status}`);
      }
      const body = tokenResponse.parse(await response.json());
      cached = {
        token: body.access_token,
        refreshAt: now() + body.expires_in * SECOND_MS - EXPIRY_MARGIN_MS,
      };
      return cached.token;
    },
  };
}

/** GOOGLE_ACCESS_TOKEN as it is when set (local development only), else the metadata server's. */
export function createGoogleAuth(accessToken: string | undefined): GoogleAuth {
  if (accessToken) {
    return { accessToken: () => Promise.resolve(accessToken) };
  }
  return metadataServerAuth();
}
