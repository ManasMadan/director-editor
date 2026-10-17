/**
 * Product analytics events, for a Looker Studio report over `director.events`
 * (packages/nest-common/src/analytics.ts has the BigQuery seam and why it's disabled
 * without BIGQUERY_DATASET).
 *
 * `record` is fire-and-forget on purpose: a slow or failing write must never hold up or
 * fail the action that triggered it, so it is never awaited here or by a caller. A
 * failure is still logged, with the kind that failed, so a gap in the report is visible
 * in the logs rather than silent.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { UserId, VideoId } from "@repo/contracts/ids";
import {
  ANALYTICS,
  type Analytics,
  describeError,
  InjectPinoLogger,
  PinoLogger,
} from "@repo/nest-common";

/**
 * Every kind this API records today, plus the kinds later tasks will: a new call site
 * picks from this list instead of inventing its own spelling. `take_reviewed` is
 * recorded by apps/ai instead (app/analytics.py, with the same spellings), once a
 * review has its score; it stays here so the two lists match. Not re-exported from
 * `index.ts`: a caller only ever needs `AnalyticsService.record("kind", fields)`, which
 * TypeScript already checks against `AnalyticsKind` below; export this list from the
 * barrel too only once something needs to enumerate or branch on every kind.
 */
export const ANALYTICS_KINDS = [
  "indexed",
  "take_reviewed",
  "cut_saved",
  "published",
  "call_started",
] as const;
export type AnalyticsKind = (typeof ANALYTICS_KINDS)[number];

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
