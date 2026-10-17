/**
 * Product analytics: one event per interesting thing someone does, streamed into
 * BigQuery for a Looker Studio report.
 *
 *   await analytics.record({ kind: "call_started", userId, videoId });
 *
 * This is a plain async write, not fire-and-forget: a caller that wants "never awaited
 * on the request path, failures logged, never fails the user's action" wraps it that way
 * itself (apps/api's AnalyticsService does, for every event the API records).
 *
 * Seam: `BigQueryAnalytics` streams rows into one BigQuery table (`director.events`)
 * through `@google-cloud/bigquery`, authenticated the same way as every other Google
 * Cloud call here (ADC: the GCE service account in production, nothing locally). A later
 * destination (a managed pipeline like Segment or PostHog, or a different warehouse)
 * gets its own `Analytics`; callers don't change. Disabled (null, from `createAnalytics`)
 * when `BIGQUERY_DATASET` is unset, so nothing is written locally or in a project without
 * a dataset.
 */
import { BigQuery } from "@google-cloud/bigquery";
import { required } from "@repo/contracts/objects";
import * as z from "zod";

export interface AnalyticsEvent {
  kind: string;
  userId?: string;
  templateId?: string;
  videoId?: string;
  score?: number;
  /** Anything else worth keeping about the event, stored as the table's JSON column. */
  detail?: unknown;
}

export interface Analytics {
  record(event: AnalyticsEvent): Promise<void>;
}

export interface BigQueryAnalyticsOptions {
  projectId: string;
  dataset: string;
  /** Defaults to "events", the only table this seam writes today. */
  table?: string;
  /**
   * Test-only: a `BigQuery` client already pointed at a stand-in server with its own
   * access token, so a test never reaches Google or the GCE metadata server (see
   * analytics.test.ts). Production always omits this and gets ADC's own client.
   */
  bigquery?: BigQuery;
}

export class BigQueryAnalytics implements Analytics {
  private readonly bigquery: BigQuery;
  private readonly dataset: string;
  private readonly table: string;

  constructor(options: BigQueryAnalyticsOptions) {
    this.bigquery = options.bigquery ?? new BigQuery({ projectId: options.projectId });
    this.dataset = options.dataset;
    this.table = options.table ?? "events";
  }

  async record(event: AnalyticsEvent): Promise<void> {
    try {
      await this.insert(event);
    } catch (error) {
      throw refusedRows(error) ?? error;
    }
  }

  private async insert(event: AnalyticsEvent): Promise<void> {
    await this.bigquery
      .dataset(this.dataset)
      .table(this.table)
      .insert([
        {
          time: new Date().toISOString(),
          kind: event.kind,
          user_id: event.userId ?? null,
          template_id: event.templateId ?? null,
          video_id: event.videoId ?? null,
          score: event.score ?? null,
          detail: event.detail === undefined ? null : JSON.stringify(event.detail),
        },
      ]);
  }
}

// What the SDK's PartialFailureError carries: per refused row, BigQuery's reasons (and
// the row itself, which is deliberately not part of this schema).
const partialFailure = z.object({
  name: z.literal("PartialFailureError"),
  errors: z.array(
    z.object({
      errors: z.array(z.object({ reason: z.string().optional(), message: z.string().optional() })),
    }),
  ),
});

/**
 * BigQuery can answer an insert with a 200 that still lists rows it refused
 * (`insertErrors`). The SDK throws a PartialFailureError for that whose message is empty,
 * so a log of it says nothing; this rewrites it as an error naming each refusal's
 * `reason: message`. Only those: the rows themselves (user and video ids) stay out of
 * the message, and the original error isn't attached as a cause for the same reason.
 */
function refusedRows(error: unknown): Error | undefined {
  const parsed = partialFailure.safeParse(error);
  if (!parsed.success) {
    return undefined;
  }
  const reasons = parsed.data.errors.flatMap((row) =>
    row.errors.map(({ reason, message }) => [reason, message].filter(Boolean).join(": ")),
  );
  return new Error(`BigQuery refused the event: ${reasons.join("; ")}`);
}

/** The configured analytics, or null when it's off (no BIGQUERY_DATASET). */
export function createAnalytics(env: {
  BIGQUERY_DATASET?: string | undefined;
  GOOGLE_CLOUD_PROJECT?: string | undefined;
}): Analytics | null {
  if (!env.BIGQUERY_DATASET) {
    return null;
  }
  return new BigQueryAnalytics({
    // A dataset without a project to write it in is a boot-time mistake, not a runtime
    // one: fail now rather than have every event quietly throw later.
    projectId: required(env.GOOGLE_CLOUD_PROJECT, "GOOGLE_CLOUD_PROJECT"),
    dataset: env.BIGQUERY_DATASET,
  });
}

export const ANALYTICS = Symbol("ANALYTICS");
