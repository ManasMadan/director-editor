import { runWithContext } from "@repo/nest-common";
import { describe, expect, it } from "vitest";
import { ownSessionOnly, refuseDemoProfileChange, refuseForDemo, visitorLimitKey } from "./demo";

const DEMO = { id: "u", demo: true, name: "Director Demo" };
const SOMEONE = { id: "v", demo: false };
const locked = expect.objectContaining({
  body: expect.objectContaining({ code: "DEMO_ACCOUNT_LOCKED" }),
});

describe("the demo account's locked endpoints", () => {
  it("refuse its session and let anyone else's through", () => {
    expect(() => refuseForDemo(DEMO)).toThrow(locked);
    expect(() => refuseForDemo(SOMEONE)).not.toThrow();
    expect(() => refuseForDemo({ id: "u" })).not.toThrow();
    expect(() => refuseForDemo(undefined)).not.toThrow();
  });
});

describe("the demo account's profile", () => {
  it("takes its browser's language and time zone, and nothing else", () => {
    const at = new Date();
    expect(() =>
      refuseDemoProfileChange({ locale: "en", timezone: "UTC", updatedAt: at }, DEMO),
    ).not.toThrow();
    expect(() => refuseDemoProfileChange({ name: undefined, timezone: "UTC" }, DEMO)).not.toThrow();
    expect(() => refuseDemoProfileChange({ name: "Defaced", updatedAt: at }, DEMO)).toThrow(locked);
    expect(() => refuseDemoProfileChange({ name: "Renamed" }, SOMEONE)).not.toThrow();
  });

  it("lets the settings form send the name it already has with a new language", () => {
    expect(() =>
      refuseDemoProfileChange({ name: "Director Demo", locale: "en", timezone: "UTC" }, DEMO),
    ).not.toThrow();
  });
});

describe("the demo account's device list", () => {
  const listed = [{ id: "mine" }, { id: "a-judges" }];

  it("is only the session asking", () => {
    expect(ownSessionOnly(listed, { user: DEMO, session: { id: "mine" } })).toEqual([
      { id: "mine" },
    ]);
  });

  it("is left alone for anyone else, without a session, or when it isn't a list", () => {
    expect(ownSessionOnly(listed, { user: SOMEONE, session: { id: "mine" } })).toBeUndefined();
    expect(ownSessionOnly(listed, null)).toBeUndefined();
    expect(ownSessionOnly({ not: "a list" }, { user: DEMO, session: { id: "mine" } })).toBe(
      undefined,
    );
  });
});

describe("whose allowance a per-user limit spends", () => {
  it("is the user's, or on the shared demo the user's from their address", () => {
    const visit = (sharedDemo: boolean) =>
      runWithContext({ requestId: "r", ip: "203.0.113.7" }, () => visitorLimitKey("u", sharedDemo));
    expect(visit(false)).toBe("u");
    expect(visit(true)).toBe("u:203.0.113.7");
  });

  it("is one allowance for the shared demo when no address is known", () => {
    expect(visitorLimitKey("u", true)).toBe("u:unknown");
    expect(runWithContext({ requestId: "r" }, () => visitorLimitKey("u", true))).toBe("u:unknown");
  });
});
