import { describe, expect, it } from "vitest";
import { browserPushState, currentSubscription, forgetBrowserPush, toDevice } from "./web-push";

const subscription = (keys?: { p256dh?: string; auth?: string }, endpoint?: string) =>
  ({
    endpoint: "https://push.example/abc",
    toJSON: () => ({ endpoint, keys }),
  }) as unknown as PushSubscription;

describe("a browser push subscription", () => {
  it("registers with its encryption keys", () => {
    expect(toDevice(subscription({ p256dh: "p", auth: "a" }, "https://push.example/abc"))).toEqual({
      platform: "web",
      subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } },
    });
  });

  it("takes the endpoint from the subscription when its JSON leaves it out", () => {
    expect(toDevice(subscription({ p256dh: "p", auth: "a" }))).toMatchObject({
      subscription: { endpoint: "https://push.example/abc" },
    });
  });

  it("is refused without them: nothing could ever be sent to it", () => {
    expect(() => toDevice(subscription())).toThrow(/no encryption keys/);
    expect(() => toDevice(subscription({ p256dh: "p" }))).toThrow(/no encryption keys/);
  });
});

describe("push where there's no browser (a server render)", () => {
  it("is unsupported, with nothing to forget", async () => {
    expect(await browserPushState()).toBe("unsupported");
    expect(await currentSubscription()).toBeNull();
    await expect(forgetBrowserPush()).resolves.toBeUndefined();
  });
});
