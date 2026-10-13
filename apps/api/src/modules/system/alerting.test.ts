import { describe, expect, it, vi } from "vitest";
import { alerting, CACHE_MS, check, FRESH_MS } from "./alerting";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

/** Alertmanager answering `body` with `status`, recording what it was asked. */
function alertmanager(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(body, { status }),
  );
}

/** A Watchdog as Alertmanager lists it, last heard `ago` ms before NOW. */
const watchdog = (ago: number, endsIn = 4 * 60_000) => ({
  labels: { alertname: "Watchdog" },
  updatedAt: at(-ago),
  endsAt: at(endsIn),
});

describe("check", () => {
  it("is ok while a Watchdog heard recently is active, asking only for Watchdogs", async () => {
    const fetcher = alertmanager([watchdog(60_000)]);
    expect(await check("http://am:9093/", fetcher, NOW)).toBe("ok");
    expect(fetcher).toHaveBeenCalledWith(
      "http://am:9093/api/v2/alerts?filter=alertname%3D%22Watchdog%22",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ["no Watchdog: Prometheus isn't sending it", []],
    ["only one heard too long ago", [watchdog(FRESH_MS + 1)]],
    ["only one that has ended", [watchdog(60_000, -1)]],
  ])("is stale with %s", async (_case, body) => {
    expect(await check("http://am:9093", alertmanager(body), NOW)).toBe("stale");
  });

  it("is stale when Alertmanager fails, answers what it shouldn't, or can't be reached", async () => {
    expect(await check("http://am:9093", alertmanager([], 503), NOW)).toBe("stale");
    expect(await check("http://am:9093", alertmanager({ not: "alerts" }), NOW)).toBe("stale");
    const down = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    expect(await check("http://am:9093", down, NOW)).toBe("stale");
  });
});

describe("alerting", () => {
  it("is off without an Alertmanager, and asks nothing", async () => {
    const fetcher = alertmanager([]);
    expect(await alerting(undefined, fetcher)()).toBe("off");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks Alertmanager at most once per CACHE_MS, however often it's called", async () => {
    let now = NOW;
    const fetcher = alertmanager([watchdog(0)]);
    const status = alerting("http://am:9093", fetcher, () => now);
    expect(await Promise.all([status(), status()])).toEqual(["ok", "ok"]);
    now += CACHE_MS - 1;
    expect(await status()).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 1;
    await status();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the real fetch and clock by default", async () => {
    const real = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json([watchdog(0)]));
    vi.setSystemTime(NOW);
    expect(await alerting("http://am:9093")()).toBe("ok");
    expect(await check("http://am:9093")).toBe("ok");
    expect(real).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    real.mockRestore();
  });
});
