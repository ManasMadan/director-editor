/**
 * Live streams for signed-in clients. A stream carries the user's channel and their
 * active workspace's (membership was checked by the inOrg procedure when it opened).
 *
 * Streams end after STREAM_LIFETIME_MS so the client reconnects and every check runs
 * again (session still valid, still a member). A user can hold MAX_STREAMS_PER_USER per
 * API process (a tab each), so one account can't exhaust connections.
 */
import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { OrgId, UserId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { realtimeChannel } from "@repo/contracts/realtime";
import { MINUTE_MS } from "@repo/contracts/time";
import { AppError, InjectPinoLogger, InjectRedis, PinoLogger, type Redis } from "@repo/nest-common";
import { RealtimeHub } from "../../realtime";

const STREAM_LIFETIME_MS = 10 * MINUTE_MS;
const MAX_STREAMS_PER_USER = 10;

@Injectable()
export class RealtimeService implements OnApplicationShutdown {
  private readonly hub: InstanceType<typeof RealtimeHub>;
  private readonly open = new Map<string, number>();

  constructor(
    @InjectRedis() redis: Redis,
    @InjectPinoLogger(RealtimeService.name) log: PinoLogger,
  ) {
    this.hub = new RealtimeHub(redis, (channel) =>
      log.warn({ channel }, "dropped a realtime message outside the contract"),
    );
  }

  /**
   * Checks before the stream starts, so a refusal is an ordinary typed error (oRPC maps
   * errors from the handler, not ones thrown while iterating).
   */
  stream(userId: UserId, orgId: OrgId, signal: AbortSignal | undefined) {
    if ((this.open.get(userId) ?? 0) >= MAX_STREAMS_PER_USER) {
      // A slot frees as soon as another tab closes its stream: worth trying again soon.
      throw new AppError("RATE_LIMITED", { params: { retryAfterSeconds: 5 } });
    }
    return this.messages(userId, orgId, signal);
  }

  private async *messages(userId: UserId, orgId: OrgId, signal: AbortSignal | undefined) {
    this.open.set(userId, (this.open.get(userId) ?? 0) + 1);
    const lifetime = AbortSignal.timeout(STREAM_LIFETIME_MS);
    const done = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
    try {
      yield* this.hub.stream([realtimeChannel.user(userId), realtimeChannel.org(orgId)], done);
    } finally {
      // Counted up when this stream started.
      const remaining = required(this.open.get(userId), "the user's stream count") - 1;
      if (remaining > 0) {
        this.open.set(userId, remaining);
      } else {
        this.open.delete(userId);
      }
    }
  }

  async onApplicationShutdown() {
    await this.hub.close();
  }
}
