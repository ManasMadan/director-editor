import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput } from "./stand-ins";
import { ALERTING, attempt, checks, greeting, hosts, type Probes, probes, uptime } from "./uptime";

afterEach(() => mock.restore());

/** A checkout whose environments have these values. */
function root(values: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "uptime-"));
  for (const [env, yaml] of Object.entries(values)) {
    mkdirSync(join(dir, "deploy/environments", env), { recursive: true });
    writeFileSync(join(dir, "deploy/environments", env, "stack.yaml"), yaml);
  }
  return dir;
}

const live = (site: string, from: string) =>
  `site:\n  host: ${site}\nservices:\n  notifications:\n    env:\n      EMAIL_FROM: ${from}\n`;

/** An HTTP answer: `status`, with `body` as its JSON. */
const answer = (status: number, body: unknown = {}) => ({ status, json: async () => body });

/** Probes that answer as everything up, unless `down` says otherwise. */
function fake(down: Partial<Probes> = {}, alerting = "ok") {
  const asked: string[] = [];
  const probe: Probes = {
    fetch: async (url) => {
      asked.push(url);
      return answer(200, url.endsWith(ALERTING) ? { status: alerting } : {});
    },
    mx: async (domain) => {
      asked.push(`mx ${domain}`);
      return [
        { exchange: `backup.${domain}`, priority: 20 },
        { exchange: `mail.${domain}`, priority: 10 },
      ];
    },
    greeting: async (host, port) => {
      asked.push(`${host}:${port}`);
      return "220 mail ESMTP\r\n";
    },
    ...down,
  };
  return { probe, asked };
}

/** Plain TCP in place of TLS, to talk to the local servers below. */
const plain = (options: { host?: string; port?: number }) =>
  connect({ host: options.host ?? "", port: options.port ?? 0 });

/** A local server that says `hello` (or nothing) to each connection. */
async function server(hello?: string) {
  const s: Server = createServer((socket) => {
    if (hello !== undefined) {
      socket.end(hello);
    }
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const address = s.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () => s.close(),
  };
}

describe("hosts", () => {
  it("reads the site's host and the email domain from the environment's values", () => {
    const dir = root({ staging: live("staging.acme.dev", "Acme <no-reply@acme.dev>") });
    expect(hosts("staging", dir)).toEqual({ site: "staging.acme.dev", mail: "acme.dev" });
  });

  it("is empty for what isn't set", () => {
    expect(hosts("staging", root({ staging: "image:\n  tag: x\n" }))).toEqual({
      site: "",
      mail: "",
    });
  });

  it("matches the environments in this repository, still on the placeholders", () => {
    expect(hosts("production")).toEqual({ site: "app.example.com", mail: "example.com" });
  });
});

describe("checks", () => {
  it("asks each site's health page and API, and the mail server its MX record names first", async () => {
    const { probe, asked } = fake();
    const dir = root({ production: live("app.acme.dev", "Acme <no-reply@acme.dev>") });
    const list = checks("production", probe, dir);
    expect(list.map(([name]) => name)).toEqual([
      "production: https://app.acme.dev/healthz",
      "production: https://app.acme.dev/api/v1/system",
      "production: alerting (Prometheus and Alertmanager)",
      "production: mail for acme.dev",
    ]);
    for (const [, check] of list) {
      await check();
    }
    expect(asked).toEqual([
      "https://app.acme.dev/healthz",
      "https://app.acme.dev/api/v1/system",
      "https://app.acme.dev/api/v1/system/alerting",
      "mx acme.dev",
      "mail.acme.dev:465",
    ]);
  });

  it("skips what's still a placeholder or unset, and says so", () => {
    const output = captureOutput();
    expect(checks("staging", fake().probe, root({ staging: live("x.example.org", "a") }))).toEqual(
      [],
    );
    expect(output()).toContain("staging: site.host isn't set (x.example.org)");
    expect(output()).toContain("staging: EMAIL_FROM's domain isn't set (empty)");
    expect(checks("staging", fake().probe, root({ staging: "{}\n" }))).toEqual([]);
    expect(output()).toContain("site.host isn't set (empty)");
  });

  it("fails a site that answers anything but 200", async () => {
    const { probe } = fake({ fetch: async () => answer(502) });
    const [[, check] = ["", async () => undefined]] = checks(
      "production",
      probe,
      root({ production: live("app.acme.dev", "x") }),
    );
    await expect(check()).rejects.toThrow("answered 502");
  });

  describe("the cluster's alerting", () => {
    const dir = root({ production: live("app.acme.dev", "x") });
    const alertingCheck = (probe: Probes) =>
      checks("production", probe, dir).find(([name]) => name.includes("alerting"))?.[1] ??
      (async () => undefined);

    it("fails while Alertmanager has no recent Watchdog", async () => {
      await expect(alertingCheck(fake({}, "stale").probe)()).rejects.toThrow(
        "Prometheus or Alertmanager is down",
      );
    });

    it("passes where there's no alerting, saying so", async () => {
      const output = captureOutput();
      await alertingCheck(fake({}, "off").probe)();
      expect(output()).toContain("production: no alerting there");
    });

    it("fails when the API doesn't answer, or answers something else", async () => {
      await expect(alertingCheck(fake({ fetch: async () => answer(404) }).probe)()).rejects.toThrow(
        `${ALERTING} answered 404`,
      );
      await expect(
        alertingCheck(fake({ fetch: async () => answer(200, { status: "fine" }) }).probe)(),
      ).rejects.toThrow();
    });
  });

  it("fails a domain with no MX record, or a mail server that doesn't greet", async () => {
    const dir = root({ production: live("app.example.com", "no-reply@acme.dev") });
    const none = checks("production", fake({ mx: async () => [] }).probe, dir);
    await expect(none[0]?.[1]()).rejects.toThrow("no MX record");
    const rude = checks("production", fake({ greeting: async () => "554 go away" }).probe, dir);
    await expect(rude[0]?.[1]()).rejects.toThrow('mail.acme.dev:465 said "554 go away"');
  });
});

describe("attempt", () => {
  it("passes once a try does, after pausing between tries", async () => {
    let tries = 0;
    const error = await attempt(
      async () => {
        tries++;
        if (tries < 3) {
          throw new Error("blip");
        }
      },
      3,
      1,
    );
    expect(error).toBeUndefined();
    expect(tries).toBe(3);
  });

  it("gives the last error once every try failed", async () => {
    expect(await attempt(() => Promise.reject(new Error("down")), 2, 1)).toBe("down");
    expect(await attempt(() => Promise.reject("refused"), 1, 1)).toBe("refused");
  });
});

describe("uptime", () => {
  const dir = root({
    staging: live("staging.example.com", "no-reply@example.com"),
    production: live("app.acme.dev", "Acme <no-reply@acme.dev>"),
  });

  it("passes when everything answers", async () => {
    const output = captureOutput();
    expect(await uptime(["staging", "production"], fake().probe, dir, 1)).toBe(0);
    expect(output()).toContain("production: mail for acme.dev");
  });

  it("fails, naming each check that's down, when anything is", async () => {
    const output = captureOutput();
    const { probe } = fake({ greeting: () => Promise.reject(new Error("connection refused")) });
    expect(await uptime(["production"], probe, dir, 1)).toBe(1);
    expect(output()).toContain("production: mail for acme.dev: connection refused");
    expect(output()).toContain("production: https://app.acme.dev/healthz");
  });
});

describe("greeting", () => {
  it("is what the server says first", async () => {
    const { port, close } = await server("220 ready\r\n");
    expect(await greeting("127.0.0.1", port, 1000, plain)).toBe("220 ready\r\n");
    close();
  });

  it("gives up on a server that says nothing", async () => {
    const { port, close } = await server();
    await expect(greeting("127.0.0.1", port, 50, plain)).rejects.toThrow("no answer in 50 ms");
    close();
  });

  it("fails where nothing listens", async () => {
    const { port, close } = await server();
    close();
    await expect(greeting("127.0.0.1", port, 1000, plain)).rejects.toThrow();
  });
});

describe("the real probes", () => {
  it("fetch without following redirects", async () => {
    const site = Bun.serve({ port: 0, fetch: () => Response.redirect("https://elsewhere", 302) });
    expect((await probes.fetch(`http://127.0.0.1:${site.port}/healthz`)).status).toBe(302);
    site.stop();
  });

  it("speak TLS to the mail server", async () => {
    const { port, close } = await server("220 not TLS\r\n");
    await expect(probes.greeting("127.0.0.1", port)).rejects.toThrow();
    close();
  });
});
