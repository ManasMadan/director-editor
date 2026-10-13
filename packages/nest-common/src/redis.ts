/**
 * A shared ioredis connection as an injectable provider.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ (blocking commands must never be
 * aborted by the retry limit) and harmless for caching, so one connection config works
 * for every use in the process.
 */
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { Redis } from "ioredis";

export const REDIS = Symbol("REDIS");
export const InjectRedis = () => Inject(REDIS);
export { Redis };

export function createRedis(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

class RedisLifecycle implements OnApplicationShutdown {
  constructor(@InjectRedis() private readonly redis: Redis) {}
  async onApplicationShutdown() {
    await this.redis.quit();
  }
}

@Global()
@Module({})
export class RedisModule {
  static forRoot(options: { url: string }): DynamicModule {
    return {
      module: RedisModule,
      providers: [{ provide: REDIS, useFactory: () => createRedis(options.url) }, RedisLifecycle],
      exports: [REDIS],
    };
  }
}
