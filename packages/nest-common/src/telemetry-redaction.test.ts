import { describe, expect, it } from "vitest";
import { redactQuery, redactSpanUrls } from "./telemetry";

describe("URLs in logs and traces", () => {
  it.each([
    ["/api/auth/callback/google?code=4%2F0Ab&state=xyz", "/api/auth/callback/google?code=&state="],
    ["/unsubscribe?token=abc&token=def", "/unsubscribe?token=&token="],
    ["https://s3.test/b/k?X-Amz-Signature=s", "https://s3.test/b/k?X-Amz-Signature="],
    ["/plain/path", "/plain/path"],
    ["/empty?", "/empty?"],
  ])("%s → %s", (url, redacted) => {
    expect(redactQuery(url)).toBe(redacted);
  });

  it("redacts every URL attribute a span carries, and nothing else", () => {
    const attributes: Record<string, unknown> = {
      "http.url": "http://h/x?code=1",
      "http.target": "/x?code=1",
      "url.full": "http://h/x?code=1",
      "url.query": "code=1&state=2",
      "http.method": "GET",
    };
    redactSpanUrls({
      attributes,
      setAttribute: (key, value) => {
        attributes[key] = value;
      },
    });
    expect(attributes).toEqual({
      "http.url": "http://h/x?code=",
      "http.target": "/x?code=",
      "url.full": "http://h/x?code=",
      "url.query": "code=&state=",
      "http.method": "GET",
    });
    // A span without attributes (not an SDK span) is left alone.
    expect(() => redactSpanUrls({ setAttribute: () => undefined })).not.toThrow();
  });
});
