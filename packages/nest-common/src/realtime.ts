/**
 * Realtime fan-out over Redis pub/sub, for a message catalog (packages/contracts
 * realtime; plumbing stays free of domain types):
 *
 *   export const { publish, RealtimeHub } = createRealtime(realtimeMessage);   // once per service
 *   await publish(redis, realtimeChannel.org(orgId), { type: "todos.changed" }); // any service
 *   for await (const message of hub.stream([userChannel, orgChannel], signal)) yield message; // api
 *
 * Any service can publish. Each API process keeps one subscriber connection, subscribes
 * to a channel while at least one local stream wants it (reference-counted) and fans
 * messages out to those streams. Delivery is best effort (pub/sub has no replay):
 * messages only say "refetch", so a missed one costs freshness, never correctness, and
 * clients refetch whenever they reconnect.
 *
 * Seam: pub/sub on the shared Redis today. At very high fan-out, move to a dedicated
 * Redis (or NATS) by giving RealtimeHub and publishRealtime another connection; callers
 * don't change.
 */
import { EventEmitter } from "node:events";
import { required } from "@repo/contracts/objects";
import type { Redis } from "ioredis";
import type * as z from "zod";

/**
 * Redis channel prefix. The Python service publishes on the same channels, named from
 * @repo/contracts' REALTIME_REDIS_PREFIX (which plumbing can't import); apps/api's
 * realtime-prefix.test.ts keeps the two equal.
 */
export const REALTIME_CHANNEL_PREFIX = "realtime:";
const PREFIX = REALTIME_CHANNEL_PREFIX;
/** Messages a slow stream may fall behind by before the oldest are dropped. */
const MAX_BUFFERED = 100;

/** A message from Redis checked against the contract (anything can publish there). */
function parseMessage<S extends z.ZodType>(schema: S, raw: string) {
  try {
    return schema.safeParse(JSON.parse(raw));
  } catch {
    return { success: false as const };
  }
}

/** Fans Redis messages out to streams; one subscriber connection per hub. */
class Hub<S extends z.ZodType> {
  private readonly subscriber: Redis;
  private readonly local = new EventEmitter<Record<string, [z.infer<S>]>>().setMaxListeners(0);
  private readonly refs = new Map<string, number>();

  /**
   * `onDropped` hears about messages outside the contract (or not JSON at all), which
   * are dropped: they come from Redis, where anything can publish.
   */
  constructor(
    schema: S,
    redis: Redis,
    onDropped: (channel: string, raw: string) => void = () => undefined,
  ) {
    // A connection in subscriber mode can't run other commands, so it gets its own.
    this.subscriber = redis.duplicate();
    this.subscriber.on("message", (channel: string, raw: string) => {
      const message = parseMessage(schema, raw);
      if (message.success) {
        this.local.emit(channel.slice(PREFIX.length), message.data);
      } else {
        onDropped(channel, raw);
      }
    });
  }

  /** Messages on these channels until `signal` aborts. */
  async *stream(
    channels: string[],
    signal: AbortSignal,
  ): AsyncGenerator<z.infer<S>, void, unknown> {
    const buffer: z.infer<S>[] = [];
    let wake: (() => void) | undefined;
    const onMessage = (message: z.infer<S>) => {
      buffer.push(message);
      if (buffer.length > MAX_BUFFERED) {
        buffer.shift();
      }
      wake?.();
    };
    // One listener for the stream's whole life, not one per wait.
    const onAbort = () => wake?.();
    signal.addEventListener("abort", onAbort, { once: true });
    for (const channel of channels) {
      this.local.on(channel, onMessage);
    }
    try {
      // Inside the try: if subscribing fails, the finally still undoes the rest.
      await Promise.all(channels.map((channel) => this.retain(channel)));
      // Drain before each wait: a message can arrive before the first one, in the same
      // read as Redis's confirmation of the subscription, while `retain` is still
      // resolving. Nothing arrives between the empty check and setting `wake` (no await).
      while (!signal.aborted) {
        const next = buffer.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      for (const channel of channels) {
        this.local.off(channel, onMessage);
      }
      await Promise.all(channels.map((channel) => this.release(channel)));
    }
  }

  private async retain(channel: string) {
    const count = (this.refs.get(channel) ?? 0) + 1;
    this.refs.set(channel, count);
    if (count === 1) {
      await this.subscriber.subscribe(PREFIX + channel);
    }
  }

  private async release(channel: string) {
    // retain() counted it before its first await, so it's there.
    const count = required(this.refs.get(channel), `${channel}'s subscriber count`) - 1;
    if (count > 0) {
      this.refs.set(channel, count);
      return;
    }
    this.refs.delete(channel);
    await this.subscriber.unsubscribe(PREFIX + channel);
  }

  async close() {
    await this.subscriber.quit();
  }
}

export function createRealtime<S extends z.ZodType>(schema: S) {
  type Message = z.infer<S>;

  async function publish(redis: Redis, channel: string, message: Message) {
    await redis.publish(PREFIX + channel, JSON.stringify(schema.parse(message)));
  }

  /** The hub for this service's messages. */
  class RealtimeHub extends Hub<S> {
    constructor(redis: Redis, onDropped?: (channel: string, raw: string) => void) {
      super(schema, redis, onDropped);
    }
  }

  return { publish, RealtimeHub };
}
