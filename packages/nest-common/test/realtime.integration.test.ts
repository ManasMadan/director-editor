/** RealtimeHub against the docker compose Valkey (private database). */
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { eventually } from "@repo/testing/eventually";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { createRealtime } from "../src/realtime";
import { redisDatabase } from "../src/testing";

const message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("todos.changed") }),
  z.object({ type: z.literal("notifications.changed") }),
]);
const { publish: publishRealtime, RealtimeHub } = createRealtime(message);
const redis = new Redis(redisDatabase(12), { maxRetriesPerRequest: null });
const dropped: string[] = [];
const hub = new RealtimeHub(redis, (channel) => dropped.push(channel));
afterAll(async () => {
  await hub.close();
  await redis.quit();
});

async function collect(channels: string[], count: number, publish: () => Promise<void>) {
  const controller = new AbortController();
  const received: unknown[] = [];
  const reading = (async () => {
    for await (const message of hub.stream(channels, controller.signal)) {
      received.push(message);
      if (received.length === count) {
        controller.abort();
      }
    }
  })();
  for (const channel of channels) {
    await subscribed(channel, 1);
  }
  await publish();
  await eventually(
    () => received.length,
    (n) => n === count,
    { interval: 10 },
  );
  controller.abort();
  await reading;
  return received;
}

async function subscribers(channel: string) {
  const [, count] = (await redis.call("PUBSUB", "NUMSUB", `realtime:${channel}`)) as [
    string,
    number,
  ];
  return count;
}

/** Waits until Redis counts `count` subscriptions to the channel. */
async function subscribed(channel: string, count: number) {
  await eventually(
    () => subscribers(channel),
    (n) => n >= count,
    { interval: 10 },
  );
}

describe("RealtimeHub", () => {
  it("keeps one abort listener however long the stream runs", async () => {
    const channel = `user:${randomUUID()}`;
    const controller = new AbortController();
    const stream = hub.stream([channel], controller.signal);
    const listeners: number[] = [];
    const reading = (async () => {
      for await (const _ of stream) {
        listeners.push(getEventListeners(controller.signal, "abort").length);
        if (listeners.length === 20) {
          controller.abort();
        }
      }
    })();
    await subscribed(channel, 1);
    // One at a time, so the stream waits (and would add a listener) before each.
    for (let i = 0; i < 20; i++) {
      await publishRealtime(redis, channel, { type: "todos.changed" });
      await eventually(
        () => listeners.length,
        (n) => n === i + 1,
      );
    }
    await reading;
    expect(listeners).toHaveLength(20);
    expect(Math.max(...listeners)).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("drops a message that isn't JSON or isn't in the contract, and keeps going", async () => {
    const channel = `user:${randomUUID()}`;
    const received = await collect([channel], 1, async () => {
      await redis.publish(`realtime:${channel}`, "not json");
      await redis.publish(`realtime:${channel}`, JSON.stringify({ type: "unknown" }));
      await publishRealtime(redis, channel, { type: "todos.changed" });
    });
    expect(received).toEqual([{ type: "todos.changed" }]);
    expect(dropped.filter((c) => c === `realtime:${channel}`)).toHaveLength(2);
  });

  it("delivers messages from every subscribed channel, and nothing else", async () => {
    const mine = `user:${randomUUID()}`;
    const team = `org:${randomUUID()}`;
    const received = await collect([mine, team], 2, async () => {
      await publishRealtime(redis, `org:${randomUUID()}`, { type: "todos.changed" });
      await publishRealtime(redis, team, { type: "todos.changed" });
      await publishRealtime(redis, mine, { type: "notifications.changed" });
    });
    expect(received).toEqual([{ type: "todos.changed" }, { type: "notifications.changed" }]);
  });

  it("unsubscribes from Redis when the last local stream ends", async () => {
    const channel = `user:${randomUUID()}`;
    await collect([channel], 1, () => publishRealtime(redis, channel, { type: "todos.changed" }));
    const [, subscribers] = (await redis.call("PUBSUB", "NUMSUB", `realtime:${channel}`)) as [
      string,
      number,
    ];
    expect(subscribers).toBe(0);
  });

  it("delivers a message that arrives in the same read as the subscription's confirmation", async () => {
    // On a busy machine Redis's confirmation and the first message can reach the client
    // together, so the message is handled before stream() is past subscribing. Holding the
    // subscriber's socket until both are sent makes that happen every time.
    const subscriber = redis.duplicate();
    vi.spyOn(redis, "duplicate").mockReturnValueOnce(subscriber);
    const racing = new RealtimeHub(redis);
    await subscriber.ping();
    const channel = `user:${randomUUID()}`;
    const controller = new AbortController();
    const stream = racing.stream([channel], controller.signal);
    subscriber.stream.pause();
    const first = stream.next();
    await subscribed(channel, 1);
    await publishRealtime(redis, channel, { type: "todos.changed" });
    // Both replies, in Redis's protocol, are in the socket's buffer before it's resumed.
    const bulk = (...parts: string[]) =>
      `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join("")}`;
    const name = `realtime:${channel}`;
    const bytes =
      bulk("subscribe", name).length +
      ":1\r\n".length +
      bulk("message", name, JSON.stringify({ type: "todos.changed" })).length;
    await eventually(
      () => subscriber.stream.readableLength,
      (length) => length === bytes,
      { interval: 10 },
    );
    subscriber.stream.resume();
    expect(await first).toEqual({ done: false, value: { type: "todos.changed" } });
    controller.abort();
    await stream.return(undefined);
    await racing.close();
  });

  it("keeps a channel subscribed until the last of its streams ends", async () => {
    const channel = `org:${randomUUID()}`;
    const first = new AbortController();
    const second = new AbortController();
    const firstStream = hub.stream([channel], first.signal);
    const secondStream = hub.stream([channel], second.signal);
    const firstNext = firstStream.next();
    const secondNext = secondStream.next();
    await subscribed(channel, 1);
    await publishRealtime(redis, channel, { type: "todos.changed" });
    expect((await firstNext).value).toEqual({ type: "todos.changed" });
    expect((await secondNext).value).toEqual({ type: "todos.changed" });

    first.abort();
    await firstStream.return(undefined);
    expect(await subscribers(channel)).toBe(1);
    const stillOpen = secondStream.next();
    await publishRealtime(redis, channel, { type: "notifications.changed" });
    expect((await stillOpen).value).toEqual({ type: "notifications.changed" });
    second.abort();
    await secondStream.return(undefined);
    expect(await subscribers(channel)).toBe(0);
  });

  it("keeps only the latest messages for a stream that falls behind", async () => {
    const channel = `user:${randomUUID()}`;
    const controller = new AbortController();
    const slow = hub.stream([channel], controller.signal);
    // Takes the first message, then reads nothing while 149 more arrive.
    const first = slow.next();
    const fast = await collect([channel], 150, async () => {
      for (let i = 0; i < 50; i++) {
        await publishRealtime(redis, channel, { type: "notifications.changed" });
      }
      for (let i = 0; i < 100; i++) {
        await publishRealtime(redis, channel, { type: "todos.changed" });
      }
    });
    expect(fast).toHaveLength(150);
    expect((await first).value).toEqual({ type: "notifications.changed" });
    // Room for 100: the other 49 notifications were dropped, oldest first.
    const behind: unknown[] = [];
    for await (const message of slow) {
      behind.push(message);
      if (behind.length === 100) {
        controller.abort();
      }
    }
    expect(behind).toEqual(Array.from({ length: 100 }, () => ({ type: "todos.changed" })));
  });

  it("drops what isn't in the contract quietly when nobody asked to hear about it", async () => {
    const quiet = new RealtimeHub(redis);
    const channel = `user:${randomUUID()}`;
    const controller = new AbortController();
    const stream = quiet.stream([channel], controller.signal);
    const next = stream.next();
    await subscribed(channel, 1);
    await redis.publish(`realtime:${channel}`, JSON.stringify({ type: "unknown" }));
    await publishRealtime(redis, channel, { type: "todos.changed" });
    expect((await next).value).toEqual({ type: "todos.changed" });
    controller.abort();
    await stream.return(undefined);
    await quiet.close();
  });

  it("refuses to publish a message outside the contract", async () => {
    await expect(publishRealtime(redis, "user:x", { type: "nope" } as never)).rejects.toThrow();
  });
});
