---
name: swap-analytics
description: Point product analytics somewhere other than BigQuery (a managed pipeline like Segment or PostHog, or a different warehouse). Use when the user decides to change where analytics events go. Not for debugging; when something fails, use the debug skill.
disable-model-invocation: true
---

# Swap product analytics

- **Interface:** `Analytics` (one method, `record(event)`) in
  `packages/nest-common/src/analytics.ts`.
- **Today:** `BigQueryAnalytics`, built by `createAnalytics(env)` in the same file (null
  when `BIGQUERY_DATASET` is unset: nothing is recorded). It streams one row per event
  into the `director.events` table with `@google-cloud/bigquery`, authenticated the same
  way as every other Google Cloud call here (ADC).
- **Provided as** `ANALYTICS` in `apps/api/src/modules/analytics/analytics.module.ts`,
  wrapped by `AnalyticsService` (`record(kind, fields)`), which makes every write
  fire-and-forget and logs a failure instead of letting it fail the caller's action.
  Every call site imports `AnalyticsService` and the `ANALYTICS_KINDS` list from
  `apps/api/src/modules/analytics` and records one of those kinds.
- **Env:** `BIGQUERY_DATASET`, and `GOOGLE_CLOUD_PROJECT` (shared with Director's live
  call), documented in `.env.example` and `docs/environment.md`.

## A managed pipeline or a different warehouse

1. A class implementing `Analytics`. `record` takes the same `AnalyticsEvent` shape
   (`kind`, `userId`, `templateId`, `videoId`, `score`, `detail`); map its fields to
   whatever the destination expects.
2. Choose it in `createAnalytics` from new variables next to `BIGQUERY_DATASET`,
   documented in `.env.example` and `docs/environment.md`. `AnalyticsService` and every
   call site stay the same.
3. If the new destination needs its own SDK, keep it inside `analytics.ts`: nothing
   outside the seam should import it.

## Tests

`packages/nest-common/src/analytics.test.ts` runs `BigQueryAnalytics` against a stand-in
HTTP server speaking BigQuery's real streaming-insert protocol, with a `BigQuery` client
carrying its own pre-set access token (so it never reaches Google or the GCE metadata
server). `apps/api/src/modules/analytics/analytics.service.test.ts` covers the
fire-and-forget wrapper against a plain stand-in `Analytics`. A new implementation needs
the same kind of protocol-speaking stand-in; add it rather than mocking the new
provider's SDK.

## Finish

1. The verify skill.
2. Ask the `reviewer` agent to review the change, and the `security-reviewer` agent: a
   new destination sends product data somewhere new.
3. Update the seam's row in the README's "Scaling path" table if what's "Now" changed.
