/**
 * Durations, named with their unit. APIs disagree on units: Redis, better-auth and
 * BullMQ's job ages take seconds; timers, `Date`, fetch timeouts and BullMQ's delays take
 * milliseconds. So write `2 * HOUR_MS` or `7 * DAY_S`, never a bare `3_600_000`
 * (scripts/durations.test.ts refuses those).
 */
export const MINUTE_S = 60;
export const HOUR_S = 60 * MINUTE_S;
export const DAY_S = 24 * HOUR_S;

export const SECOND_MS = 1000;
export const MINUTE_MS = MINUTE_S * SECOND_MS;
export const HOUR_MS = HOUR_S * SECOND_MS;

/** How long one call to a third-party provider (push, SMS, a webhook receiver) may take. */
export const PROVIDER_TIMEOUT_MS = 10 * SECOND_MS;
