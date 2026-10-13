import { describe, expect, it, vi } from "vitest";
import { renderHook, standIn } from "../../../test/stand-in";
import { useSystemInfoQuery } from "./info";

describe("system info", () => {
  it("says which features are on and what's running", async () => {
    const info = {
      release: "1.4.0",
      features: { ai: true, billing: false, captcha: false, files: true, google: false },
      minimumClientVersion: "1.0.0",
      captchaSiteKey: null,
      webPushPublicKey: null,
    };
    const api = standIn((os) => ({ system: { info: os.system.info.handler(() => info) } }));
    const { result } = renderHook(() => useSystemInfoQuery(), api);
    await vi.waitFor(() => expect(result.current.data).toEqual(info));
  });
});
