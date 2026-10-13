import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import {
  DatabaseModule,
  HealthModule,
  I18nModule,
  LoggerModule,
  REDIS,
  type Redis,
  RedisModule,
} from "@repo/nest-common";
import { NotificationsModule } from "./dispatch/notifications.module";
import { env } from "./env";

@Module({
  imports: [
    LoggerModule.forRoot({
      service: "notifications",
      level: env.LOG_LEVEL,
      pretty: env.NODE_ENV === "development",
    }),
    DatabaseModule.forRoot({
      url: env.NOTIFICATIONS_DATABASE_URL,
      poolMax: env.NOTIFICATIONS_DATABASE_POOL_MAX,
      service: "notifications",
    }),
    RedisModule.forRoot({ url: env.REDIS_URL }),
    // Copy for every channel, through the MessageSource seam (bundled catalog today).
    I18nModule.forRoot(),
    // Queues reuse the service's single, lifecycle-managed Redis connection.
    BullModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: Redis) => ({ connection: redis }),
    }),
    // The queues are this service's lifeline, so Redis is part of readiness.
    HealthModule.forRoot(["db", "redis"]),
    NotificationsModule,
  ],
})
export class AppModule {}
