/** Jobs written through the typed producer, read back from a real Valkey. */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
// Through the package's entry point, as the services import it.
import { createProducer, parseJob } from "../src";

// The jobs package's own Valkey database (docs/testing.md).
const url = new URL(process.env.REDIS_URL as string);
url.pathname = "/19";
const connection = new Redis(url.toString(), { maxRetriesPerRequest: null });
const producer = createProducer("notifications-critical", connection);
// Only the jobs this file added: the queue is the real one, and other runs may use it.
const added: string[] = [];
afterAll(async () => {
  await Promise.all(added.map(async (id) => (await producer.queue.getJob(id))?.remove()));
  await producer.close();
  await connection.quit();
});

const payload = (otp: string) =>
  ({
    template: "auth.otp",
    to: { email: "ada@example.com", locale: "en" },
    data: { otp, purpose: "sign-in", expiresInMinutes: 5 },
  }) as const;

describe("producer", () => {
  it("stores a job under the id it's given, with its metadata, once", async () => {
    const jobId = randomUUID();
    added.push(jobId);
    await producer.add("send", payload("111111"), { jobId, meta: { requestId: "r-1" } });
    await producer.add("send", payload("222222"), { jobId });
    const job = await producer.queue.getJob(jobId);
    expect(parseJob("notifications-critical", "send", job?.data)).toEqual({
      meta: { requestId: "r-1" },
      payload: payload("111111"),
    });
  });

  it("stores many jobs in one go, each checked like a single one", async () => {
    const ids = [randomUUID(), randomUUID()];
    added.push(...ids);
    await producer.addBulk(
      ids.map((jobId, n) => ({ name: "send", payload: payload(`33333${n}`), options: { jobId } })),
    );
    const jobs = await Promise.all(ids.map((id) => producer.queue.getJob(id)));
    expect(jobs.map((job) => job?.data.payload.data.otp)).toEqual(["333330", "333331"]);
    expect(jobs.map((job) => job?.data.meta)).toEqual([{}, {}]);
    await expect(
      producer.addBulk([{ name: "send", payload: payload("444444"), options: { jobId: "a:b" } }]),
    ).rejects.toThrow(/without ":"/);
  });
});
