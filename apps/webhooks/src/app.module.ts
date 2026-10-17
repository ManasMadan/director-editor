import { Module } from "@nestjs/common";
import { DatabaseModule, HealthModule, LoggerModule, RedisModule } from "@repo/nest-common";
import { env } from "./env";

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
    HealthModule.forRoot(["db", "redis"]),
  ],
})
export class AppModule {}
