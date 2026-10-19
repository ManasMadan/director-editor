(Review 1 of task 2.6.2 — findings to fix, from an Opus reviewer, with the controller's rulings.)

Critical 1 — production api pod can't reach the metadata server (egress blocks 169.254.0.0/16).
RULING: resolved outside this task. Task 2.2.4 (merging before this one) adds a per-service `allowMetadataServer` egress exception (169.254.169.254/32 TCP 80) for api, worker, ai and ai-worker, chart-tested. Do NOT add your own. Turning the live call on in production via GOOGLE_CLOUD_PROJECT on the api is intended.

Important 2 — `take_reviewed` fires at submission (apps/api/src/modules/director/director.service.ts:108), score always null; reviews that later fail still count.
RULING: option (a). Remove the api call site. Record `take_reviewed` WITH its score in apps/ai at the end of `review()` (apps/ai/app/director.py, right after the score update), through a small Python analytics seam in apps/ai (an `Analytics` protocol, a BigQuery implementation using `google-cloud-bigquery` with ADC, disabled when BIGQUERY_DATASET is unset), fire-and-forget (never fails the review; failures logged with context), same row shape as the api (time ISO UTC, kind, user_id, template_id, video_id, score, detail JSON string). Settings in apps/ai/app/settings.py + .env.example + docs/environment.md; production BIGQUERY_DATASET for ai and ai-worker in deploy/environments/production/stack.yaml with a helm-unittest case; dependency added the way apps/ai adds dependencies (uv, pinned per its rules); tested against a local stand-in HTTP server speaking insertAll (as the TS test does) or the client with an injected transport — a test fixture, never a fake in app code. Keep 100% coverage of apps/ai.

Important 3 — packages/nest-common/src/analytics.ts:64: PartialFailureError (HTTP 200 with insertErrors) logs an empty message. Fix: catch it in the adapter and rethrow an Error listing each row error's `reason: message` (no row data). Stand-in test answering 200 with insertErrors. Do the same in the Python adapter.

Minor 4 — .claude/skills/swap-analytics/SKILL.md:18: say "call AnalyticsService.record with one of AnalyticsKind" (ANALYTICS_KINDS isn't in the barrel).
Minor 5 — apps/api/src/modules/live/live.relay.ts:219: guard onCallStarted with `justStarted && !this.ended`, with a test.
Minor 6 — apps/api/src/env.ts:109: BIGQUERY_DATASET regex `^[A-Za-z0-9_]{1,1024}$` (and the same in apps/ai settings).
Minor 7 — packages/nest-common/package.json:63: note the google-auth-library version coupling in the test header, or group the two packages in renovate.json5.
