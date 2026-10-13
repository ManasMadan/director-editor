/**
 * Fetch for URLs we don't control (customer webhook endpoints, links an AI tool follows).
 * A plain `fetch(url)` there is a server-side request forgery hole: a user registers
 * `http://169.254.169.254/...` or `http://postgres:5432` and makes our servers call
 * internal systems. This wrapper:
 *
 * - resolves the hostname itself and refuses it unless every address is public unicast
 *   (not loopback, private, link-local, cloud metadata, CGNAT, multicast; IPv4 and IPv6,
 *   including IPv4-mapped IPv6), with `resolvePermitted`, which checking a webhook URL
 *   on registration uses too; then connects to exactly the address it checked,
 *   so a DNS answer cannot change between check and connect;
 * - follows redirects itself (at most 3), re-checking each hop, or not at all with
 *   `followRedirects: false` (webhook delivery: a redirect would carry the body and its
 *   signature somewhere else, and Standard Webhooks senders don't follow them);
 * - requires https unless `allowHttp` is set, and caps time and response size.
 *
 * The network layer adds a second wall: the services' egress NetworkPolicies allow DNS,
 * their own namespace, the mail and observability namespaces, and the internet outside
 * private ranges, so another namespace, a node and a metadata address stay unreachable
 * even if a check here were wrong.
 */
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { fieldOf, required } from "@repo/contracts/objects";
import { PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { AppError, isAppError } from "./errors";
import { asError } from "./job-processor";

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowHttp?: boolean;
  /** When false, a redirect is the answer (its status), not followed. Default true. */
  followRedirects?: boolean;
  /**
   * Exact private addresses to permit, for tests and local development only (e.g.
   * `["127.0.0.1"]` for a local receiver). Everything else private stays blocked.
   */
  allowedPrivateAddresses?: readonly string[];
}

export interface SafeFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** True only for addresses on the public internet. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) {
    return false;
  }
  // An IPv4-mapped IPv6 address (::ffff:10.0.0.1) is judged as the IPv4 address it is.
  return ipaddr.process(address).range() === "unicast";
}

const permitted = (address: string, allowlist: readonly string[]) =>
  isPublicAddress(address) || allowlist.includes(address);

/**
 * The host's addresses, if every one is public or allowlisted; otherwise
 * DESTINATION_NOT_ALLOWED. All of them, not just one: a name that also answers with a
 * private address is refused outright rather than connected to whichever address is
 * public. A failed lookup is thrown as it is, so callers can tell DNS down from no such
 * host.
 */
export async function resolvePermitted(
  hostname: string,
  allowlist: readonly string[],
  resolve: (hostname: string) => Promise<{ address: string; family: number }[]> = (name) =>
    lookup(name, { all: true, verbatim: true }),
) {
  const addresses = await resolve(hostname);
  if (addresses.length === 0 || !addresses.every(({ address }) => permitted(address, allowlist))) {
    throw new AppError("DESTINATION_NOT_ALLOWED", { params: { hostname } });
  }
  return addresses;
}

/** A DNS lookup that answers only when `resolvePermitted` allows the host (exported for tests). */
export function guardedLookup(
  allowlist: readonly string[],
  resolve?: Parameters<typeof resolvePermitted>[2],
): LookupFunction {
  return (hostname, options, callback) => {
    resolvePermitted(hostname, allowlist, resolve)
      .then(([chosen]) => {
        const { address, family } = required(chosen, `an address for ${hostname}`);
        if (options.all) {
          callback(null, [{ address, family }]);
        } else {
          callback(null, address, family);
        }
      })
      .catch((error: unknown) => callback(asError(error), "", 4));
  };
}

/** Refuses plain HTTP (unless allowed) and a literal IP that isn't public or allowlisted. */
function checkDestination(url: URL, allowHttp: boolean, allowlist: readonly string[]) {
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new AppError("DESTINATION_NOT_ALLOWED", { params: { reason: "https-required" } });
  }
  // Literal IPs never go through DNS, so check them here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host) && !permitted(host, allowlist)) {
    throw new AppError("DESTINATION_NOT_ALLOWED", { params: { hostname: host } });
  }
}

/** The body as text, cancelled with RESPONSE_TOO_LARGE once it passes `maxResponseBytes`. */
async function readLimited(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  maxResponseBytes: number,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxResponseBytes) {
      await reader.cancel();
      throw new AppError("RESPONSE_TOO_LARGE", { params: { maxResponseBytes } });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const {
    timeoutMs = PROVIDER_TIMEOUT_MS,
    maxResponseBytes = 1_000_000,
    allowHttp = false,
    followRedirects = true,
    allowedPrivateAddresses = [],
  } = options;
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(allowedPrivateAddresses) } });
  const deadline = AbortSignal.timeout(timeoutMs);

  try {
    let current = new URL(url);
    for (let hop = 0; hop <= 3; hop++) {
      checkDestination(current, allowHttp, allowedPrivateAddresses);

      const response = await undiciFetch(current, {
        method: options.method ?? "GET",
        ...(options.headers && { headers: options.headers }),
        ...(options.body !== undefined && { body: options.body }),
        redirect: "manual",
        dispatcher,
        signal: deadline,
      }).catch((error: unknown) => {
        // A lookup refused above reaches here as undici's "fetch failed", with the
        // refusal as its cause: that's the answer, not a failure to connect.
        const cause = fieldOf(error, "cause");
        throw isAppError(cause) ? cause : error;
      });

      const location = response.headers.get("location");
      if (followRedirects && response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        current = new URL(location, current);
        continue;
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await readLimited(response.body?.getReader(), maxResponseBytes),
      };
    }
    throw new AppError("TOO_MANY_REDIRECTS");
  } finally {
    await dispatcher.close();
  }
}
