/**
 * Product analytics events, for a Looker Studio report over `director.events`
 * (packages/nest-common/src/analytics.ts has the BigQuery seam and why it's disabled
 * without BIGQUERY_DATASET).
 *
 * `record` is fire-and-forget on purpose: a slow or failing write must never hold up or
 * fail the action that triggered it, so it is never awaited here or by a caller. A
 * failure is still logged, with the kind that failed, so a gap in the report is visible
 * in the logs rather than silent.
 *
 * The kinds are @repo/contracts/activity's ANALYTICS_KINDS, which apps/ai records under
 * the same spellings (`indexed` and `take_reviewed` are only recorded there, once a plan
 * is ready and once a review has its score).
 */
import { Inject, Injectable } from "@nestjs/common";
import type { AnalyticsKind } from "@repo/contracts/activity";
import type { UserId, VideoId } from "@repo/contracts/ids";
import {
  ANALYTICS,
  type Analytics,
  describeError,
  InjectPinoLogger,
  PinoLogger,
} from "@repo/nest-common";

export interface AnalyticsFields {
  userId?: UserId;
  templateId?: string;
  videoId?: VideoId;
  score?: number;
  detail?: unknown;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(ANALYTICS) private readonly analytics: Analytics | null,
    @InjectPinoLogger(AnalyticsService.name) private readonly log: PinoLogger,
  ) {}

  record(kind: AnalyticsKind, fields: AnalyticsFields = {}): void {
    if (!this.analytics) {
      return;
    }
    void this.analytics.record({ kind, ...fields }).catch((error: unknown) => {
      this.log.warn({ err: describeError(error), kind }, "failed to record an analytics event");
    });
  }
}
