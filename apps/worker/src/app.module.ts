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
import { AuditModule } from "./audit/audit.module";
import { env } from "./env";
import { FilesModule } from "./files/files.module";
import { MaintenanceModule } from "./maintenance/maintenance.module";
import { OutboxModule } from "./outbox/outbox.module";
import { RealtimeModule } from "./realtime/realtime.module";

@Module({
  imports: [
    LoggerModule.forRoot({
      service: "worker",
      level: env.LOG_LEVEL,
      pretty: env.NODE_ENV === "development",
    }),
    DatabaseModule.forRoot({
      url: env.WORKER_DATABASE_URL,
      poolMax: env.WORKER_DATABASE_POOL_MAX,
      service: "worker",
    }),
    RedisModule.forRoot({ url: env.REDIS_URL }),
    BullModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: Redis) => ({ connection: redis }),
    }),
    HealthModule.forRoot(["db", "redis"]),
    OutboxModule,
    AuditModule,
    FilesModule,
    MaintenanceModule,
    RealtimeModule,
  ],
})
export class AppModule {}
