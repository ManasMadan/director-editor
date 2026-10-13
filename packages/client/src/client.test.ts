import { afterEach, describe, expect, it, vi } from "vitest";
import { id, standIn } from "../test/stand-in";
import { createApiClient } from "./client";
import { errorCode } from "./errors";

const info = {
  release: "1.0.0",
  features: { ai: false, billing: false, captcha: false, files: false, google: false },
  minimumClientVersion: "1.0.0",
  captchaSiteKey: null,
  webPushPublicKey: null,
};

/** A stand-in that also records each request as sent. */
function recording() {
  const api = standIn((os) => ({ system: { info: os.system.info.handler(() => info) } }));
  const sent: { url: string; headers: Headers; credentials: RequestCredentials | undefined }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, headers: request.headers, credentials: init?.credentials });
    return api.fetch(request);
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApiClient", () => {
  it("sends the app version, the locale and any extra headers, with cookies", async () => {
    const { fetch, sent } = recording();
    const { client } = createApiClient({
      baseUrl: "http://api.test",
      appVersion: "2.1.0",
      getLocale: () => "es",
      getHeaders: async () => ({ cookie: `session=${id(1)}` }),
      fetch,
    });
    await expect(client.system.info()).resolves.toEqual(info);
    const [request] = sent;
    expect(request?.url).toBe("http://api.test/rpc/system/info");
    expect(request?.credentials).toBe("include");
    expect(request?.headers.get("x-app-version")).toBe("2.1.0");
    expect(request?.headers.get("x-locale")).toBe("es");
    expect(request?.headers.get("cookie")).toBe(`session=${id(1)}`);
  });

  it("leaves out the headers it has no value for", async () => {
    const { fetch, sent } = recording();
    const { client } = createApiClient({
      baseUrl: "http://api.test",
      getLocale: () => undefined,
      fetch,
    });
    await client.system.info();
    expect(sent[0]?.headers.has("x-app-version")).toBe(false);
    expect(sent[0]?.headers.has("x-locale")).toBe(false);
  });

  it("calls the page's own origin in a browser, with the browser's fetch", async () => {
    const { fetch, sent } = recording();
    vi.stubGlobal("window", { location: { origin: "http://web.test" } });
    vi.stubGlobal("fetch", fetch);
    const { client } = createApiClient();
    await expect(client.system.info()).resolves.toEqual(info);
    expect(sent[0]?.url).toBe("http://web.test/rpc/system/info");
  });

  it("has nowhere to call outside a browser without a baseUrl", async () => {
    const { fetch, sent } = recording();
    vi.stubGlobal("window", undefined);
    const error = await createApiClient({ fetch })
      .client.system.info()
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("SERVICE_UNAVAILABLE");
    expect(sent).toHaveLength(0);
  });
});
