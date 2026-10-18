import { Module } from "@nestjs/common";
import {
  DatabaseModule,
  HealthModule,
  I18nModule,
  LoggerModule,
  RedisModule,
} from "@repo/nest-common";
import { AuthModule } from "./auth/auth.module";
import { env } from "./env";
import { AnalyticsModule } from "./modules/analytics";
import { DirectorModule } from "./modules/director";
import { FilesModule } from "./modules/files";
import { RealtimeModule } from "./modules/realtime";
import { UserModule } from "./modules/user";
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
    HealthModule.forRoot(["db", "redis"]),
    I18nModule.forRoot(),
    NotificationsProducerModule,
    AuthModule,
    UserModule,
    RealtimeModule,
    FilesModule,
    AnalyticsModule,
    DirectorModule,
  ],
})
export class AppModule {}
