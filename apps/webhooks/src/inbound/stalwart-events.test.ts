import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bouncedAddress,
  eventKey,
  isFresh,
  isHardBounce,
  type StalwartEvent,
  stalwartBatch,
  verifySignature,
} from "./stalwart-events";

// Requests Stalwart v0.16.24 sent (the compose service, captured as received), with the
// X-Signature it computed. The key is compose's local placeholder, not a secret.
const KEY = "change-me";
const permanent = {
  body: '{"events":[{"id":"1790708406087","createdAt":"2026-09-29T19:00:06Z","type":"delivery.dsn-perm-fail","data":{"spanId":332248439297409537,"to":"gone@bounce.test","hostname":"127.0.0.1","details":"Unexpected response for RCPT TO:<gone@bounce.test>: Code: 550, Enhanced code: 5.1.2, Message: Relay not allowed.","total":0,"queueId":332248439293215233,"queueName":"remote","from":"no-reply@boilerplate.test","size":306}}]}',
  signature: "+jupgx2C+ygt8YK72yHvQlS1UemqgKNVjJJx0QO6ado=",
};
const temporary = {
  body: '{"events":[{"id":"1790708509189","createdAt":"2026-09-29T19:01:49Z","type":"delivery.dsn-temp-fail","data":{"spanId":332248665053726721,"to":"later@defer.test","hostname":"127.0.0.1","details":"Connection failed: I/O error: Connection refused (os error 111)","nextRetry":"2026-09-29T19:01:50Z","expires":"2026-10-02T19:01:48Z","total":1,"queueId":332248662723790337,"queueName":"remote","from":"no-reply@boilerplate.test","size":306}}]}',
  signature: "zJfBYXc3omYzel8sdwLUrmbps/hHKFemS0YgSJbFd2c=",
};
// One event as two webhooks received it: Stalwart numbered it again for the second.
const sameEvent = [
  '{"events":[{"id":"1790708588287","createdAt":"2026-09-29T19:03:08Z","type":"delivery.dsn-perm-fail","data":{"spanId":332248820123445761,"to":"gone2@bounce.test","hostname":"127.0.0.1","details":"Unexpected response for RCPT TO:<gone2@bounce.test>: Code: 550, Enhanced code: 5.1.2, Message: Relay not allowed.","total":0,"queueId":332248820119243265,"queueName":"remote","from":"no-reply@boilerplate.test","size":307}}]}',
  '{"events":[{"id":"1790708588387","createdAt":"2026-09-29T19:03:08Z","type":"delivery.dsn-perm-fail","data":{"spanId":332248820123445761,"to":"gone2@bounce.test","hostname":"127.0.0.1","details":"Unexpected response for RCPT TO:<gone2@bounce.test>: Code: 550, Enhanced code: 5.1.2, Message: Relay not allowed.","total":0,"queueId":332248820119243265,"queueName":"remote","from":"no-reply@boilerplate.test","size":307}}]}',
];

const eventsOf = (body: string) => stalwartBatch.parse(JSON.parse(body)).events;
const eventOf = (body: string) => eventsOf(body)[0] as StalwartEvent;
const permFail = (details: string, to: unknown = "someone@example.com"): StalwartEvent => ({
  id: "1",
  createdAt: "2026-09-29T19:00:06Z",
  type: "delivery.dsn-perm-fail",
  data: { to, details },
});
const rcpt = (code: string, enhanced: string) =>
  `Unexpected response for RCPT TO:<someone@example.com>: Code: ${code}, Enhanced code: ${enhanced}, Message: whatever`;

describe("verifySignature", () => {
  it("accepts Stalwart's own signatures", () => {
    expect(verifySignature([KEY], permanent.body, permanent.signature)).toBe(true);
    expect(verifySignature([KEY], temporary.body, temporary.signature)).toBe(true);
  });

  it("accepts any of several keys, so a rotation can overlap", () => {
    expect(verifySignature(["the-new-key", KEY], permanent.body, permanent.signature)).toBe(true);
  });

  it("refuses another key, a changed body, and a malformed or empty header", () => {
    expect(verifySignature(["another-key"], permanent.body, permanent.signature)).toBe(false);
    const changed = permanent.body.replace("gone@bounce.test", "else@bounce.test");
    expect(verifySignature([KEY], changed, permanent.signature)).toBe(false);
    expect(verifySignature([KEY], permanent.body, "not base64 at all")).toBe(false);
    expect(verifySignature([KEY], permanent.body, permanent.signature.slice(0, 20))).toBe(false);
    expect(verifySignature([KEY], permanent.body, "")).toBe(false);
  });

  it("is the HMAC-SHA256 of the body under the key's bytes, base64", () => {
    const body = '{"events":[]}';
    const signature = createHmac("sha256", "k".repeat(40)).update(body).digest("base64");
    expect(verifySignature(["k".repeat(40)], body, signature)).toBe(true);
    // The hex encoding of the same digest is not accepted.
    const hex = createHmac("sha256", "k".repeat(40)).update(body).digest("hex");
    expect(verifySignature(["k".repeat(40)], body, hex)).toBe(false);
  });
});

describe("stalwartBatch", () => {
  it("parses the captured requests", () => {
    expect(eventOf(permanent.body)).toMatchObject({
      id: "1790708406087",
      type: "delivery.dsn-perm-fail",
      data: { to: "gone@bounce.test", queueName: "remote" },
    });
    expect(eventOf(temporary.body).type).toBe("delivery.dsn-temp-fail");
  });

  it("refuses an empty batch and events missing their fields", () => {
    expect(stalwartBatch.safeParse({ events: [] }).success).toBe(false);
    expect(stalwartBatch.safeParse({}).success).toBe(false);
    const { createdAt: _, ...noDate } = eventOf(permanent.body);
    expect(stalwartBatch.safeParse({ events: [noDate] }).success).toBe(false);
    expect(
      stalwartBatch.safeParse({ events: [{ ...noDate, createdAt: "yesterday" }] }).success,
    ).toBe(false);
  });
});

describe("isFresh", () => {
  const events = eventsOf(permanent.body);
  const createdAt = Date.parse("2026-09-29T19:00:06Z");
  const minute = 60 * 1000;

  it("accepts events up to ten minutes old or ahead (clock skew)", () => {
    expect(isFresh(events, createdAt)).toBe(true);
    expect(isFresh(events, createdAt + 10 * minute)).toBe(true);
    expect(isFresh(events, createdAt - 10 * minute)).toBe(true);
  });

  it("refuses a replay from later, or a batch from too far ahead", () => {
    expect(isFresh(events, createdAt + 10 * minute + 1)).toBe(false);
    expect(isFresh(events, createdAt - 10 * minute - 1)).toBe(false);
  });

  it("refuses the whole batch when any event is stale", () => {
    const mixed = [...events, { ...eventOf(permanent.body), createdAt: "2026-09-29T18:00:00Z" }];
    expect(isFresh(mixed, createdAt)).toBe(false);
  });
});

describe("eventKey", () => {
  it("is the same for one event however Stalwart numbered it", () => {
    const [first, second] = sameEvent.map(eventOf);
    expect(first?.id).not.toBe(second?.id);
    expect(eventKey(first as StalwartEvent)).toBe(eventKey(second as StalwartEvent));
  });

  it("differs between events", () => {
    const keys = [permanent.body, temporary.body, sameEvent[0] as string].map((body) =>
      eventKey(eventOf(body)),
    );
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isHardBounce", () => {
  it("is a hard bounce when the address or its domain doesn't exist", () => {
    expect(isHardBounce(rcpt("550", "5.1.1"))).toBe(true); // no such user
    expect(isHardBounce(rcpt("550", "5.1.2"))).toBe(true); // no such domain
    expect(isHardBounce(rcpt("553", "5.1.3"))).toBe(true); // bad address syntax
    expect(isHardBounce(rcpt("550", "5.1.10"))).toBe(true); // null MX
    expect(isHardBounce(rcpt("550", "5.2.1"))).toBe(true); // mailbox disabled
    expect(isHardBounce("DNS lookup failed: Domain not found: NXDomain")).toBe(true);
    expect(isHardBounce("DNS lookup failed: Domain does not accept messages (null MX)")).toBe(true);
  });

  it("uses the enhanced code whichever command was refused (LMTP answers after DATA)", () => {
    expect(
      isHardBounce(
        "Unexpected response for DATA: Code: 550, Enhanced code: 5.1.1, Message: no such user",
      ),
    ).toBe(true);
  });

  it("is not one for problems with the message, our server or our sender address", () => {
    expect(isHardBounce(rcpt("550", "5.7.1"))).toBe(false); // spam policy, blocklisted IP
    expect(isHardBounce(rcpt("552", "5.2.2"))).toBe(false); // mailbox full
    expect(isHardBounce(rcpt("552", "5.3.4"))).toBe(false); // message too big
    expect(isHardBounce(rcpt("550", "5.1.7"))).toBe(false); // bad sender mailbox
    expect(isHardBounce(rcpt("550", "5.1.8"))).toBe(false); // bad sender domain
    expect(isHardBounce(rcpt("450", "4.1.1"))).toBe(false); // temporary, never a hard bounce
    expect(isHardBounce("TLS error: invalid peer certificate")).toBe(false);
    expect(isHardBounce("MTA-STS auth failed: Record not found: NXDomain")).toBe(false);
    expect(isHardBounce("DANE authentication failure: no matching TLSA record")).toBe(false);
    expect(isHardBounce("")).toBe(false);
  });

  it("without an enhanced code, only a recipient refused as unknown at RCPT TO", () => {
    expect(isHardBounce(rcpt("550", "0.0.0"))).toBe(true);
    expect(isHardBounce(rcpt("551", "0.0.0"))).toBe(true);
    expect(isHardBounce(rcpt("553", "0.0.0"))).toBe(true);
    expect(isHardBounce(rcpt("554", "0.0.0"))).toBe(false);
    expect(isHardBounce(rcpt("552", "0.0.0"))).toBe(false);
    expect(
      isHardBounce("Unexpected response for DATA: Code: 550, Enhanced code: 0.0.0, Message: spam"),
    ).toBe(false);
    expect(
      isHardBounce(
        "Unexpected response for MAIL FROM:<no-reply@example.com>: Code: 550, Enhanced code: 0.0.0, Message: no",
      ),
    ).toBe(false);
  });
});

describe("bouncedAddress", () => {
  it("is the recipient of a permanent failure that is a hard bounce", () => {
    expect(bouncedAddress(eventOf(permanent.body))).toBe("gone@bounce.test");
  });

  it("is null for temporary failures and other events", () => {
    expect(bouncedAddress(eventOf(temporary.body))).toBeNull();
    expect(bouncedAddress({ ...permFail(rcpt("550", "5.1.1")), type: "delivery.delivered" })).toBe(
      null,
    );
  });

  it("is null for a permanent failure that isn't the address's fault", () => {
    expect(bouncedAddress(permFail(rcpt("550", "5.7.1")))).toBeNull();
  });

  it("is null without usable details or recipient", () => {
    expect(bouncedAddress({ ...permFail(""), data: { to: "someone@example.com" } })).toBeNull();
    expect(bouncedAddress(permFail(rcpt("550", "5.1.1"), "not an address"))).toBeNull();
    expect(bouncedAddress(permFail(rcpt("550", "5.1.1"), ["a@example.com"]))).toBeNull();
    expect(bouncedAddress({ ...permFail(""), data: { details: rcpt("550", "5.1.1") } })).toBeNull();
  });
});
