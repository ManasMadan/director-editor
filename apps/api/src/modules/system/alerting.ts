/**
 * Whether the cluster's alerting is alive, for the dead man's switch outside it
 * (scripts/uptime.ts, through `system.alerting`). Prometheus fires the Watchdog alert all
 * the time and resends it to Alertmanager every minute or so; Alertmanager holding one
 * it heard from recently means both are running. Anything else (no Watchdog, an old one,
 * no answer) is `stale`. Only the verdict leaves this file, never Alertmanager's answer.
 */
import { MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
import * as z from "zod";

export type AlertingStatus = "ok" | "stale" | "off";

/** How old the last Watchdog may be: a few of Prometheus's resends. */
export const FRESH_MS = 10 * MINUTE_MS;
/** How long a verdict is reused: the endpoint is public, Alertmanager isn't asked per call. */
export const CACHE_MS = 30 * SECOND_MS;

const alerts = z.array(z.object({ updatedAt: z.iso.datetime(), endsAt: z.iso.datetime() }));

/** Asks Alertmanager at `url` once. */
export async function check(
  url: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<"ok" | "stale"> {
  try {
    const response = await fetcher(
      `${url.replace(/\/$/, "")}/api/v2/alerts?filter=${encodeURIComponent('alertname="Watchdog"')}`,
      { signal: AbortSignal.timeout(5 * SECOND_MS) },
    );
    if (!response.ok) {
      return "stale";
    }
    const live = alerts
      .parse(await response.json())
      .some((a) => now - Date.parse(a.updatedAt) < FRESH_MS && Date.parse(a.endsAt) > now);
    return live ? "ok" : "stale";
  } catch {
    // Unreachable, timed out or an answer we can't read: all mean nobody hears alerts.
    return "stale";
  }
}

/** The status, asking Alertmanager at most once per CACHE_MS; `off` without one. */
export function alerting(
  url: string | undefined,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  let last: { at: number; status: Promise<AlertingStatus> } | undefined;
  return (): Promise<AlertingStatus> => {
    if (!url) {
      return Promise.resolve("off");
    }
    const now = clock();
    if (!last || now - last.at >= CACHE_MS) {
      last = { at: now, status: check(url, fetcher, now) };
    }
    return last.status;
  };
}
