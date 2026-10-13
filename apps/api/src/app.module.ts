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
import { AuthModule } from "./auth/auth.module";
import { env } from "./env";
import { AiModule } from "./modules/ai";
import { ApiKeysModule } from "./modules/api-keys";
import { AppsModule } from "./modules/apps";
import { AuditModule } from "./modules/audit";
import { BillingModule } from "./modules/billing";
import { FilesModule } from "./modules/files";
import { NotificationsModule } from "./modules/notifications";
import { RealtimeModule } from "./modules/realtime";
import { TodoModule } from "./modules/todo";
import { UserModule } from "./modules/user";
import { WebhooksModule } from "./modules/webhooks";
import { NotificationsProducerModule } from "./notifications";

@Module({
  imports: [
    LoggerModule.forRoot({
      service: "api",
      level: env.LOG_LEVEL,
      pretty: env.NODE_ENV === "development",
    }),
    DatabaseModule.forRoot({
      url: env.API_DATABASE_URL,
      poolMax: env.API_DATABASE_POOL_MAX,
      service: "api",
    }),
    RedisModule.forRoot({ url: env.REDIS_URL }),
    // Queue consumers in this service (billing's share of domain events).
    BullModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: Redis) => ({ connection: redis }),
    }),
    HealthModule.forRoot(["db", "redis"]),
    I18nModule.forRoot(),
    NotificationsProducerModule,
    AuthModule,
    TodoModule,
    UserModule,
    AiModule,
    AppsModule,
    ApiKeysModule,
    AuditModule,
    WebhooksModule,
    RealtimeModule,
    NotificationsModule,
    FilesModule,
    BillingModule,
  ],
})
export class AppModule {}
