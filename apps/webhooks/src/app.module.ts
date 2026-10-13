import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import {
  DatabaseModule,
  HealthModule,
  LoggerModule,
  REDIS,
  type Redis,
  RedisModule,
} from "@repo/nest-common";
import { env } from "./env";
import { OutboundModule } from "./outbound/outbound.module";

@Module({
  imports: [
    LoggerModule.forRoot({
      service: "webhooks",
      level: env.LOG_LEVEL,
      pretty: env.NODE_ENV === "development",
    }),
    DatabaseModule.forRoot({
      url: env.WEBHOOKS_DATABASE_URL,
      poolMax: env.WEBHOOKS_DATABASE_POOL_MAX,
      service: "webhooks",
    }),
    RedisModule.forRoot({ url: env.REDIS_URL }),
    BullModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: Redis) => ({ connection: redis }),
    }),
    HealthModule.forRoot(["db", "redis"]),
    OutboundModule,
  ],
})
export class AppModule {}
