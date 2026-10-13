/**
 * The dead man's switch, from outside the clusters: `bun scripts/uptime.ts`. Alerts go
 * out through each cluster's own Alertmanager and mail server, so a cluster that dies,
 * or whose mail server does, can't say so. This asks what the internet sees instead: for
 * each environment, the site's health page and the API through the gateway
 * (`site.host` in deploy/environments/<env>/stack.yaml), and the mail server's
 * submission port (465, implicit TLS) on the host the email domain's MX record names
 * (the domain of the notifications service's `EMAIL_FROM`), which must greet with 220.
 * And whether the cluster's own alerting is alive: the API's `system.alerting` must not
 * be `stale`, which it is once Alertmanager has no recent Watchdog, the alert Prometheus
 * always fires (apps/api src/modules/system/alerting.ts); `off` where there's no
 * alerting to watch. Each check gets three tries, so one dropped request doesn't count. Hosts still on the
 * placeholders (example.com) are skipped. Prints what failed and exits 1 if anything
 * did; uptime.yml runs it every half hour and keeps an issue open while it fails.
 */
import { resolveMx } from "node:dns/promises";
import { readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ConnectionOptions, connect } from "node:tls";
import * as z from "zod";
import { fail, ok, ROOT, runMain, warn } from "./lib";

export const ENVIRONMENTS = ["staging", "production"];

/** The public paths each site must answer 200 on: the web app's and the API's. */
export const PATHS = ["/healthz", "/api/v1/system"];

/** The API's verdict on the cluster's alerting. */
export const ALERTING = "/api/v1/system/alerting";
const alerting = z.object({ status: z.enum(["ok", "stale", "off"]) });

/** Unset, or one of RFC 2606's reserved domains, which the values hold until set. */
const placeholder = (host: string) => !host || /(^|\.)example\.(com|net|org)$/.test(host);

/** What hosts reads of an environment's values; what's unset is empty. */
const stackValues = z.object({
  site: z.object({ host: z.string().default("") }).prefault({}),
  services: z
    .object({
      notifications: z
        .object({ env: z.object({ EMAIL_FROM: z.string().default("") }).prefault({}) })
        .prefault({}),
    })
    .prefault({}),
});

/** An environment's site host and email domain, from its values. */
export function hosts(env: string, root = ROOT) {
  const { site, services } = stackValues.parse(
    Bun.YAML.parse(readFileSync(join(root, "deploy/environments", env, "stack.yaml"), "utf8")),
  );
  const from = services.notifications.env.EMAIL_FROM;
  return { site: site.host, mail: /@([^>\s]+)>?\s*$/.exec(from)?.[1] ?? "" };
}

type Connect = (options: ConnectionOptions) => Socket;

/** The first thing the server at host:port says over TLS, within `timeoutMs`. */
export function greeting(host: string, port: number, timeoutMs = 10_000, open: Connect = connect) {
  return new Promise<string>((resolve, reject) => {
    const socket = open({ host, port, servername: host });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`no answer in ${timeoutMs} ms`)));
    socket.once("data", (data) => {
      socket.destroy();
      resolve(String(data));
    });
    socket.once("error", reject);
  });
}

export type Probes = {
  fetch: (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;
  mx: (domain: string) => Promise<{ exchange: string; priority: number }[]>;
  greeting: (host: string, port: number) => Promise<string>;
};

export const probes: Probes = {
  fetch: (url) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) }),
  mx: resolveMx,
  greeting: (host, port) => greeting(host, port),
};

/** Each check of an environment: a name, and what throws when it's down. */
export function checks(env: string, probe: Probes = probes, root = ROOT) {
  const { site, mail } = hosts(env, root);
  const list: [string, () => Promise<void>][] = [];
  if (placeholder(site)) {
    warn(`${env}: site.host isn't set (${site || "empty"}): site skipped`);
  } else {
    for (const path of PATHS) {
      list.push([
        `${env}: https://${site}${path}`,
        async () => {
          const { status } = await probe.fetch(`https://${site}${path}`);
          if (status !== 200) {
            throw new Error(`answered ${status}`);
          }
        },
      ]);
    }
    list.push([
      `${env}: alerting (Prometheus and Alertmanager)`,
      async () => {
        const response = await probe.fetch(`https://${site}${ALERTING}`);
        if (response.status !== 200) {
          throw new Error(`${ALERTING} answered ${response.status}`);
        }
        const { status } = alerting.parse(await response.json());
        if (status === "stale") {
          throw new Error("no recent Watchdog in Alertmanager: Prometheus or Alertmanager is down");
        }
        if (status === "off") {
          warn(`${env}: no alerting there (observability is off)`);
        }
      },
    ]);
  }
  if (placeholder(mail)) {
    warn(`${env}: EMAIL_FROM's domain isn't set (${mail || "empty"}): mail skipped`);
  } else {
    list.push([
      `${env}: mail for ${mail}`,
      async () => {
        const [first] = (await probe.mx(mail)).sort((a, b) => a.priority - b.priority);
        if (!first) {
          throw new Error("no MX record");
        }
        const hello = await probe.greeting(first.exchange, 465);
        if (!hello.startsWith("220")) {
          throw new Error(`${first.exchange}:465 said ${JSON.stringify(hello.slice(0, 80))}`);
        }
      },
    ]);
  }
  return list;
}

/** Runs a check up to `tries` times; the last error, or undefined once it passes. */
export async function attempt(check: () => Promise<void>, tries = 3, pause = 10_000) {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await check();
      return undefined;
    } catch (error) {
      last = error;
      if (i < tries - 1) {
        await sleep(pause);
      }
    }
  }
  return last instanceof Error ? last.message : String(last);
}

/** Every environment's checks; the exit code. */
export async function uptime(
  envs = ENVIRONMENTS,
  probe: Probes = probes,
  root = ROOT,
  pause = 10_000,
): Promise<number> {
  let down = 0;
  for (const env of envs) {
    for (const [name, check] of checks(env, probe, root)) {
      const error = await attempt(check, 3, pause);
      if (error === undefined) {
        ok(name);
      } else {
        fail(`${name}: ${error}`);
        down++;
      }
    }
  }
  return down ? 1 : 0;
}

await runMain(import.meta, uptime);
