import { newWebhookSecret } from "@repo/nest-common";
import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";
import { signatureHeaders } from "./signing";

describe("Standard Webhooks signing", () => {
  it("produces signatures the reference library accepts", () => {
    const secret = newWebhookSecret();
    const body = JSON.stringify({ type: "todo.created.v1", data: { title: "Hi" } });
    const headers = signatureHeaders([secret], "01a0ea00-0000-7000-8000-000000000000", body);
    const payload = new Webhook(secret).verify(body, headers);
    expect(payload).toEqual(JSON.parse(body));
  });

  it("fails on a changed body, another secret or an old timestamp", () => {
    const secret = newWebhookSecret();
    const body = '{"a":1}';
    const headers = signatureHeaders([secret], "msg", body);
    expect(() => new Webhook(secret).verify('{"a":2}', headers)).toThrow();
    expect(() => new Webhook(newWebhookSecret()).verify(body, headers)).toThrow();
    const old = signatureHeaders([secret], "msg", body, Date.now() - 60 * 60 * 1000);
    expect(() => new Webhook(secret).verify(body, old)).toThrow();
  });

  it("signs with both secrets during a rotation, and receivers holding either accept it", () => {
    const [next, previous] = [newWebhookSecret(), newWebhookSecret()];
    const body = '{"a":1}';
    const headers = signatureHeaders([next, previous], "msg", body);
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
    expect(new Webhook(next).verify(body, headers)).toEqual({ a: 1 });
    expect(new Webhook(previous).verify(body, headers)).toEqual({ a: 1 });
    expect(() => new Webhook(newWebhookSecret()).verify(body, headers)).toThrow();
  });

  it("signs the timestamp it sends, in whole seconds", () => {
    const headers = signatureHeaders([newWebhookSecret()], "msg", "{}", 1_700_000_000_999);
    expect(headers["webhook-timestamp"]).toBe("1700000000");
  });

  it("refuses a secret that isn't a Standard Webhooks one", () => {
    expect(() => signatureHeaders(["whsec_!!"], "msg", "{}")).toThrow();
  });
});
