import { Module } from "@nestjs/common";
import { ANALYTICS, createAnalytics } from "@repo/nest-common";
import { env } from "../../env";
import { AnalyticsService } from "./analytics.service";

@Module({
  providers: [
    // Null when analytics is off (no BIGQUERY_DATASET): AnalyticsService.record is then a no-op.
    { provide: ANALYTICS, useFactory: () => createAnalytics(env) },
    AnalyticsService,
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
