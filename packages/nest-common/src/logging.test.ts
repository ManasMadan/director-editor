import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestIdGenerator } from "./logging";

const request = (peer: string | undefined, id?: string | string[]) =>
  ({
    headers: id === undefined ? {} : { "x-request-id": id },
    socket: { remoteAddress: peer },
  }) as unknown as IncomingMessage;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("request ids", () => {
  const generate = createRequestIdGenerator(["loopback", "10.0.0.0/8"]);

  it("keeps the id a trusted proxy sent", () => {
    expect(generate(request("10.1.2.3", "gateway-abc.123"))).toBe("gateway-abc.123");
    expect(generate(request("127.0.0.1", "r1"))).toBe("r1");
  });

  it("mints its own for anyone else, a malformed id, or none at all", () => {
    expect(generate(request("203.0.113.9", "chosen-by-caller"))).toMatch(uuid);
    expect(generate(request("10.1.2.3", "has spaces"))).toMatch(uuid);
    expect(generate(request("10.1.2.3", "x".repeat(129)))).toMatch(uuid);
    expect(generate(request("10.1.2.3", ["a", "b"]))).toMatch(uuid);
    expect(generate(request("10.1.2.3"))).toMatch(uuid);
    // A socket already gone has no peer address.
    expect(generate(request(undefined, "r1"))).toMatch(uuid);
  });
});
