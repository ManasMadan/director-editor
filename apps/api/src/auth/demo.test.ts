import { describe, expect, it } from "vitest";
import { ownSessionOnly, refuseDemoProfileChange, refuseForDemo } from "./demo";

const DEMO = { id: "u", demo: true };
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
