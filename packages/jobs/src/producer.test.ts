import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import { createProducer, idOf, isJobName, jobName, parseJob } from "./producer";
import { queues, WEBHOOK_RETRY_DELAYS_MS } from "./queues";

const payload = {
  template: "auth.otp",
  to: { email: "ada@example.com", locale: "en" },
  data: { otp: "123456", purpose: "sign-in", expiresInMinutes: 5 },
} as const;

describe("parseJob", () => {
  it("returns metadata and a validated payload", () => {
    const { meta, payload: parsed } = parseJob("notifications-critical", "send", {
      meta: { requestId: "r-1" },
      payload,
    });
    expect(meta).toEqual({ requestId: "r-1" });
    expect(parsed.template).toBe("auth.otp");
  });

  it("refuses a job its queue doesn't have", () => {
    expect(() =>
      parseJob("notifications-critical", "nope" as never, { meta: {}, payload }),
    ).toThrow('Unknown job "nope" on queue "notifications-critical"');
  });

  it("rejects payloads that break the contract, and data without the envelope", () => {
    expect(() =>
      parseJob("notifications-critical", "send", {
        meta: {},
        payload: { ...payload, to: { email: "nope", locale: "en" } },
      }),
    ).toThrow(UnrecoverableError);
    // Retrying can't fix it, so the job fails at once rather than with full backoff.
    expect(() => parseJob("notifications-critical", "send", payload)).toThrow(UnrecoverableError);
  });
});

describe("jobName, isJobName and idOf", () => {
  it("accept only the queue's own job names", () => {
    expect(jobName("maintenance", "files-cleanup")).toBe("files-cleanup");
    expect(isJobName("maintenance", "send")).toBe(false);
    // Not an own key of the queue's jobs, though every object has it.
    expect(isJobName("maintenance", "toString")).toBe(false);
    expect(() => jobName("files", "send")).toThrow('Unknown job "send" on queue "files"');
  });

  it("returns a job's id, and refuses a job without one", () => {
    expect(idOf({ id: "job-1", name: "send" })).toBe("job-1");
    expect(() => idOf({ id: undefined, name: "send" })).toThrow('Job "send" has no id');
  });
});

describe("createProducer", () => {
  // A connection that never connects: validation fails before anything is sent.
  const producer = createProducer("notifications-critical", {
    host: "127.0.0.1",
    port: 1,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
  } as never);

  it("refuses job ids BullMQ can't store", async () => {
    await expect(producer.add("send", payload, { jobId: "a:b" })).rejects.toThrow(/without ":"/);
    await expect(producer.add("send", payload, { jobId: "" })).rejects.toThrow(/non-empty/);
  });
});

describe("queue contracts", () => {
  it("retries webhook deliveries once per step of the delivery schedule", () => {
    expect(queues["webhook-deliveries"].options.attempts).toBe(WEBHOOK_RETRY_DELAYS_MS.length + 1);
  });
});
